#!/bin/bash
# usage: tests/e2e/run.sh [extension dir]   (default: ../../firefox)
#
# Copies the extension into a temp dir, adds a test page that runs test.js
# against real Firefox APIs, launches a throwaway Firefox profile via web-ext
# and prints the results the page posts back to server.py.
# Needs Node.js (npx web-ext), Python 3 and a desktop Firefox; set FIREFOX to
# override the binary path. Exit status is 1 when any check fails.
set -e
H=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-$H/../../firefox}
PORT=${PORT:-8765}
FIREFOX=${FIREFOX:-/Applications/Firefox.app/Contents/MacOS/firefox}
WORK=$(mktemp -d)
LOG="$WORK/results.log"
PROFILE="$WORK/profile"
WX=""
SRV=""

cleanup() {
  [ -n "$WX" ] && kill "$WX" 2>/dev/null || true
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null || true
  # web-ext does not stop the Firefox it started.
  pkill -f -- "-profile $PROFILE" 2>/dev/null || true
  sleep 2
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir "$PROFILE"

cp -R "$SRC" "$WORK/ext"
cp "$H/test.js" "$WORK/ext/"
echo '<!doctype html><meta charset=utf-8><title>tests</title><script src="test.js"></script>' > "$WORK/ext/test.html"
echo "setTimeout(() => browser.tabs.create({url: browser.runtime.getURL('test.html?port=$PORT')}), 2500);" > "$WORK/ext/zz-boot.js"
python3 - "$WORK/ext/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m["background"]["scripts"].append("zz-boot.js")
json.dump(m, open(p, "w"), indent=2)
PY

python3 "$H/server.py" "$PORT" "$LOG" &
SRV=$!
sleep 1
kill -0 "$SRV" 2>/dev/null || { echo "FAIL server.py did not start (is port $PORT in use?)"; exit 1; }

# --keep-profile-changes makes Firefox use $PROFILE itself instead of a copy,
# so its command line carries a path that only this run owns.
npx --yes web-ext run --source-dir "$WORK/ext" --no-reload --firefox="$FIREFOX" \
  --firefox-profile="$PROFILE" --keep-profile-changes > "$WORK/webext.log" 2>&1 &
WX=$!

for _ in $(seq 1 240); do
  grep -q '"name": "\(DONE\|HARNESS\)"' "$LOG" 2>/dev/null && break
  sleep 1
done

python3 - "$LOG" <<'PY'
import json, sys
try:
    rows = [json.loads(l) for l in open(sys.argv[1])]
except FileNotFoundError:
    print("FAIL no results: the test page never reported (see web-ext log)")
    sys.exit(1)
for r in rows:
    show = not r["pass"] or r["name"].endswith("(info)") or r["name"] == "DONE"
    print(("PASS " if r["pass"] else "FAIL ") + r["name"] + ("  :: " + str(r["detail"])[:900] if show else ""))
done = [r for r in rows if r["name"] == "DONE"]
sys.exit(0 if done and all(r["pass"] for r in rows) else 1)
PY
