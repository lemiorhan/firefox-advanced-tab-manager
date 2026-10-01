# Sync Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> This plan carries interfaces, decisions and acceptance criteria, not implementation. Cite existing code by symbol. Grep every symbol named here before relying on it.

**Goal:** With the user's opt-in, keep a copy of the rules-and-settings backup in `browser.storage.sync`, one slot per device, so a new device can restore it.

**Architecture:** The backup object that `exportRules()` builds today moves into a new shared file, `firefox/backup.js`, together with a codec that splits it into `storage.sync` items. A writer in the persistent background page watches `storage.local` and rewrites this device's slot when the content changes. The options page gets an "Automatic backup" section: an opt-in toggle, a status line, and a list of every device's slot with restore and delete buttons. Restore goes through the same code path and the same `importMode` choice as file import.

**Tech Stack:** Firefox WebExtension, Manifest V2, plain classic scripts (no modules, no bundler). Tests are the real-Firefox e2e harness `tests/e2e/run.sh` with `tests/e2e/test.js`.

**Spec:** No spec file. The decisions below, settled in a grilling session on 2026-10-01 plus the audit that followed it, are the spec.

## Decisions (the spec)

Settled with the user (question number in brackets):

- **D1 (Q1, Q4):** Goal is moving rules to a new device. Surviving an uninstall is out of scope: Firefox clears `storage.sync` on uninstall and syncs that deletion to other devices (read in Firefox `Extension.sys.mjs` `clearOnUninstall` and application-services `webext-storage` `api.rs`; not run).
- **D2 (Q2):** Slot content is the same object `exportRules()` writes to the file: `schema`, `version`, `exportedAt`, `settings` (four keys), `groups`.
- **D3 (Q3):** It is a backup, not live sync. Nothing touches live rules unless the user presses restore.
- **D4 (Q5):** Opt-in toggle in the options page, off by default. No new manifest `permissions` entry.
- **D5 (Q6):** Write on every relevant `storage.local` change, debounced; skip the write when the content equals what the slot already holds.
- **D6 (Q7):** Restore offers the existing `replace` / `merge` choice (`input[name="importMode"]`) and runs through the file-import code path.
- **D7 (Q8):** Device identity is a random id kept in `storage.local`. The label is automatic: OS from `browser.runtime.getPlatformInfo()` plus the slot's creation date.
- **D8 (Q9):** Compact JSON. On a quota error, show the error in the section; each slot row has a delete button. Nothing is deleted automatically.
- **D9 (Q10):** When the toggle is turned on and slots from other devices already exist, the restore offer is shown at once. After that, the slot list stays in the section. A foreign slot that arrives later (Sync is slow) only appears in the list; it does not trigger the offer.
- **D10 (Q11):** Turning the toggle off stops writing and leaves the slot in `storage.sync`, marked as stopped.

Made while writing the plan, from code reading:

- **D11:** The writer lives in the background page. The popup writes `groups` too (`popup.html` loads `shared.js`, whose `handleFormSubmit`, `deleteRule` and move-rule paths call `storage.local.set`), so an options-page writer would miss those changes.
- **D12:** Deleting this device's own slot is allowed only while the toggle is off, because the next write would bring it back.
- **D13:** Slot meta carries a layout version, `format`. Devices on different extension versions share one `storage.sync`; a reader must tell an unknown layout from a corrupt one.

Made after the audit (evidence in "Verified facts"):

- **D14 (chunk encoding):** Each chunk item is a JSON **array of whole rule objects**, packed greedily in rule order. A chunk is closed when adding the next rule would push `utf8(key) + utf8(JSON.stringify(array))` past `SYNC_BACKUP_CHUNK_BUDGET_BYTES`. A rule that does not fit alone in an item makes the encoder throw an error whose message says the rule is too large; the writer reports it as a status error. Rejected alternative: slicing the JSON text into string chunks — JSON-escaping a string chunk grows it by an amount that depends on the content (measured 1.07 to 1.28 times on realistic and quote-heavy rules, 3 bytes per UTF-16 unit worst case), and a slice can split a surrogate pair.
- **D15 (hash):** Content hash is SHA-256 as lowercase hex, computed with `crypto.subtle.digest` over the text `JSON.stringify` of the backup object **without `exportedAt`**. Therefore `contentHash`, `encodeSlot` and `listSlots` are `async`. Chosen over a hand-rolled sync hash because an independent oracle for it exists (Node's `crypto`, the known vector for "abc").
- **D16 (writer serialization):** At most one write runs at a time. A trigger that arrives while a write runs sets a "dirty" flag and causes exactly one more run afterwards. The device id is created and read inside that serialized run.
- **D17 (invalid stored rule):** `validateAndNormalizeRule` throws on a rule without a name or pattern, while the background (`findMatchingRule`) silently skips such rules. If building the backup throws, the writer records the message in `syncBackupStatus.error`, writes nothing to `storage.sync`, and leaves the previous slot as it was.
- **D18 (status of a readable-looking slot):** `listSlots` reports `"unknown-format"` also when the reassembled backup has `version` greater than `EXPORT_VERSION`, or when `parseBackupPayload` throws on it. Restore is disabled for anything that is not `"complete"`.

Open, not a coding task (take to the user before release):

- **D19:** `firefox/manifest.json` declares `data_collection_permissions.required = ["none"]`. Whether an opt-in copy of rule names and URL patterns in Firefox Sync changes that is **not verified** by any source the audit found. The maintainer asks AMO (add-ons forum or Notes for Reviewers) before the release; a conservative fallback is adding `optional: ["technicalAndInteraction"]` and keeping `required`. This plan does not edit `data_collection_permissions`.

## Verified facts (audit run on 2026-10-01)

Run on Firefox 157.0 in the e2e profile (`strict_min_version` is 140, so behaviour on 140 is not verified). Reading of Firefox and application-services `main`, not of the 140 tag.

- Baseline: `tests/e2e/run.sh` on the unchanged tree finished with every row PASS and a `DONE` row.
- `browser.storage.sync` get, set, remove work in the fresh profile without a Firefox Account. `QUOTA_BYTES`, `QUOTA_BYTES_PER_ITEM`, `MAX_ITEMS` are **not** exposed on the API object, so `backup.js` declares them itself.
- Per-item limit: `utf8(key) + utf8(JSON.stringify(value))` must be at most the per-item limit; a multi-byte string counts bytes, not characters.
- Total limit: `sum(key bytes + value JSON bytes) + 4 * itemCount + 1` must be at most the total limit, over every item of every device. Item limit applies at the same time.
- A rejected `set()` (per-item, total, or item count) writes none of its keys. The error is `"QuotaExceededError: storage.sync API call exceeded its quota limitations."` for every case, so the message does not say which limit failed.
- A quota check is made on the resulting state: rewriting an item at the same size at the brim is accepted.
- `storage.onChanged` with area `"sync"` fires for writes from the background page in an extension tab, and **also fires when the same value is written again** (`oldValue` equals `newValue`).
- `remove([keys])` removes all in one call and yields one `onChanged` event.
- `browser.runtime.getPlatformInfo()` works without extra permission. `crypto.randomUUID()` and `crypto.subtle.digest` work in both the options page and the background page.
- A 3-second `setTimeout` set in the persistent background page fires.
- No write rate limit was seen for 200 small sequential writes. Large writes and real syncing were not tested, and the constants named `MAX_WRITE_OPERATIONS_PER_*` exist in the API schema without a verified enforcement; do not claim "no rate limit".
- Sizes, from `measure-sizes.js` and `measure-quota.js` (audit scratchpad, generator seed 12345, node; not run in Firefox): the "typical" scenario is 117 to 119 bytes per rule from 50 rules up; 500 typical rules need 8 chunks with encoding B; a single slot of typical rules fills the total limit at 840 rules, of "heavy" (multi-pattern) rules at 474. The numbers move with the generator's rule mix, so they size the UI warning and the tests, not a promise to users.
- Reinstalling creates a new device id and so a new slot; slots of stale devices keep taking quota until the user deletes them (follows from D7 and the shared total limit).
- Sync facts from MDN `storage.sync` page (saved in the audit scratchpad as `sync.md`; documentation, not run): on desktop the user must have "Add-ons" selected in the Sync section of `about:preferences`; Firefox for Android does not synchronize it (bug 1625257); data is synced every 10 minutes or on "Sync Now"; the extension needs a manifest id (`firefox/manifest.json` has `browser_specific_settings.gecko.id`).

## Global Constraints

- `manifest.json` `permissions` does not change. `strict_min_version` stays `140.0`. `data_collection_permissions` is untouched (D19).
- UI copy is English, like the rest of `options.html`. Where the copy says what Firefox does, say "encrypted by Firefox Sync", not "end-to-end encrypted" (not verified from a primary source).
- Firefox limits live in `backup.js` under the names `SYNC_QUOTA_BYTES`, `SYNC_QUOTA_BYTES_PER_ITEM`, `SYNC_MAX_ITEMS` (the names `api.rs` uses). The packing budget is `SYNC_BACKUP_CHUNK_BUDGET_BYTES` = per-item limit minus `SYNC_BACKUP_CHUNK_MARGIN_BYTES`. Do not scatter the digits.
- `SYNC_BACKUP_KEY_PREFIX` is `"atm-backup:"`. Keys of one device: prefix + deviceId + `":meta"` and prefix + deviceId + `":c"` + chunk index. The device id is a `crypto.randomUUID()` value and contains no colon. Every `storage.sync` key the feature writes starts with the prefix; the reader ignores the rest.
- Meta item fields: `format` (the number 1), `label`, `createdAt`, `active`, `chunkCount`, `ruleCount`, `hash`, `schema`, `version`, `exportedAt`, `settings`. Chunk item value: the array of rule objects.
- Script loading is classic scripts. Order in `manifest.json` `background.scripts` is `backup.js`, `sync-backup.js`, `background.js`; in `options.html` it is `shared.js`, `backup.js`, `options.js`. Consequences:
  - A top-level name must be unique across `backup.js`, `sync-backup.js`, `background.js`, `shared.js`, `options.js`. A `const` or `let` that `background.js` also declares is a `SyntaxError` that stops the whole background script.
  - `backup.js` must not define `normalizeCreatedOrders` (it already exists, identically, in `shared.js` and in `background.js`; leave both alone).
  - `sync-backup.js` runs before `background.js`, so at load time it may use only `backup.js` symbols and the `browser` API. It calls `background.js` functions (`normalizeCreatedOrders`) only lazily, inside handlers.
- Testability: `bg.X` and `opt.X` reach function declarations and `var`, not `const`/`let`. The `backup.js` and `sync-backup.js` API is function declarations. Constants a test reads or overrides (the three limits, `SYNC_BACKUP_KEY_PREFIX`, `SYNC_BACKUP_DEBOUNCE_MS`) are `var`. The debounce knob is read when a write is scheduled, never captured at load, so a test can lower it.
- No new dependencies. Repo files are edited with Edit/Write, not Bash heredocs.
- E2E runs headless (user decision, 2026-10-01: Firefox windows kept opening and closing). Prefix `MOZ_HEADLESS=1` to `bash tests/e2e/run.sh` and to every scratch copy of that harness, mutation runs included. Checked once on a clean `git archive HEAD` copy with `PORT=8799`: exit 0, 44 PASS, 0 FAIL, DONE row `39 checks, 4 info rows`, 248 s (headed baseline: 249.82 s, same counts). The variable reaching the Firefox process was seen with `ps eww`; that no window opens was not verified (no accessibility permission to count windows). A check that passes headed and fails headless is reported as found; it is not edited to fit.
- Comments: default is none; only a constraint, a caller dependency or a surprising behaviour earns a line.
- No commit, no push. No edits to `README.md`, `CONTRIBUTING.md` or other documents in this run (Task 7 is a separate turn).

## Mutation proof budget (user decision, 2026-10-01; applies to Tasks 2-5 and overrides any broader mutant list in the run prompt)

Task 1's implementer had reported results for 37 distinct mutant ids by 10:23 local and had been running since 09:42 (count parsed from its transcript's tool results, run at 10:23); the user judged that too slow for the remaining tasks. For Tasks 2-5:

- One mutant per new test, on the single line or branch that test exists to protect. No second mutant for the same behaviour, no variant mutants (`??` versus `||`, trim versus no trim) unless the first one survived.
- Several mutants may share one Firefox launch when they sit in different tests and cannot mask each other; revert all of them in the same turn.
- A survivor is fixed by strengthening the test and re-running only that mutant.
- Wiring mutants (dropping a script from `manifest.json` or `options.html`) count once per wiring point, not once per test.
- Tests that cannot be mutated cheaply go in `unproven` with the reason; that is acceptable here and is not a blocker by itself.
- The full e2e run (`tests/e2e/run.sh`) is still run once per implement or fix round, and once by the verifier.

## Review Focus

1. **Rule names and patterns with non-ASCII characters or many `"` characters.** Every item the encoder produces is accepted by the real `storage.sync.set()`. Pinned in Task 2.
2. **A slot that shrinks.** Deleting rules can need fewer chunks than before. Leftover chunk keys are removed, and a reader never stitches an old chunk onto a new slot. Pinned in Tasks 2 and 3.
3. **A slot that arrived from Sync only partly, from a newer extension version, or with a version `parseBackupPayload` rejects.** The row says so, restore is disabled, the page does not throw. Pinned in Tasks 2 and 5.
4. **Quota exceeded, a rule too large for one item, and an invalid stored rule.** Live rules stay untouched, the section shows the error, the previous slot stays intact, and the next successful write clears the error. Pinned in Task 3.
5. **The writer's own triggers.** The writer itself writes `syncBackupStatus` and `syncBackupDeviceId` to `storage.local`, and `background.js` writes `groups` once in `migrateStorage`. Writes that change no source key never cause a slot write, and overlapping triggers coalesce. Pinned in Task 3.
6. **Sync `onChanged` noise.** It fires even for an identical rewrite, and also for this device's own writes. The options page re-renders only the slot list and status line (never the rules list) and never writes in response. Pinned in Task 5.
7. **Test leakage.** `storage.local.clear()` in `test.js` does not clear `storage.sync`, and a toggle left on keeps the persistent writer writing through every later check. Every new check that turns the toggle on turns it off and empties its `storage.sync` keys in the same check.

---

### Task 0: Baseline (done in the audit; repeat only the lint)

- [x] `tests/e2e/run.sh` on the unchanged tree: every row PASS (audit, 2026-10-01).
- [ ] Run `npx web-ext lint --source-dir firefox` on the unchanged tree (`CONTRIBUTING.md` asks for it before a pull request) and record the result; record the wall-clock time of `tests/e2e/run.sh`, because the harness stops waiting for the `DONE` row after a fixed number of seconds (`seq 1 240` in `run.sh`) and the new checks add waiting time.

### Task 1: Move the backup format into `firefox/backup.js`

**Files:**
- Create: `firefox/backup.js`
- Modify: `firefox/options.js`, `firefox/options.html` (load `backup.js` after `shared.js`, before `options.js`), `firefox/manifest.json` (`background.scripts`)
- Test: `tests/e2e/test.js`

**Interfaces:**
- Moves from `options.js` into `backup.js`, unchanged: `EXPORT_SCHEMA`, `LEGACY_EXPORT_SCHEMAS`, `EXPORT_VERSION`, `STORAGE_COLORS`, `normalizeStorageColor`, `validateAndNormalizeRule`, `validateRuleNames`, `parseBackupPayload` (checked in the audit: DOM-free, depends only on these). Stays in `options.js`: `mergeGroups` (needs `normalizeCreatedOrders` from `shared.js`), `importRules`, `exportRules`.
- Produces: `buildBackupObject(groups, settings, exportedAt)` — pure; no storage, no DOM. `groups` is an array of already-normalized-order rules; each goes through `validateAndNormalizeRule` and the result may throw (D17). `settings` is the raw stored values of `groupUnmatched`, `groupSortMode`, `groupColorMode`, `selectedTabTheme`, possibly undefined. `buildBackupObject` owns the defaults and normalization `exportRules()` applies today: `groupUnmatched` defaults to true; `groupSortMode` is `"creation"` or else `"alphabetical"`; `groupColorMode` is `"random"` or else `"assigned"`; `selectedTabTheme` is true only when it is `=== true`. Returns the object `exportRules()` builds today, key order unchanged.
- `exportRules()` still reads storage (through `getGroupsWithCreatedOrder`) and now calls `buildBackupObject`. The downloaded file does not change.

**Acceptance:**
- Existing checks `export: produces JSON backup with schema and settings`, `import: parse legacy raw array and schema object`, `import: full importRules replace via File` pass unchanged.
- New checks with hand-written expected objects (not read from `validateAndNormalizeRule` or any table in the code): settings keys missing; `groupSortMode` set to a bad string; `groupUnmatched` non-boolean; a rule with `"grey"` colour becomes `"gray"`; an invalid rule makes it throw.
- Wiring: `typeof bg.buildBackupObject === "function"`, `typeof opt.buildBackupObject === "function"`, `typeof opt.parseBackupPayload === "function"`, and `typeof bg.getSettings === "function"` (the last proves `background.js` still loaded). Dropping `backup.js` from `manifest.json` or from `options.html` turns one of these red.
- `web-ext lint` reports nothing new compared with Task 0.
- Mutation-gate the new checks.

### Task 2: Slot codec in `firefox/backup.js`

**Files:** Modify `firefox/backup.js`; test in `tests/e2e/test.js`.

**Interfaces:**
- `async contentHash(backupObject)` → lowercase hex SHA-256 of the text `JSON.stringify` of `{schema, version, settings, groups}` (D15).
- `async encodeSlot(deviceId, backupObject, meta)` → `{ items, keys }`. `meta` is `{ label, createdAt, active }`; the encoder adds `format`, `chunkCount`, `ruleCount`, `hash`, and copies `schema`, `version`, `exportedAt`, `settings` from the backup object. `items` is ready for one `storage.sync.set()`; `keys` lists every key in it. Packs per D14; throws the rule-too-large error.
- `async listSlots(allSyncItems)` → array, one entry per device id found under `SYNC_BACKUP_KEY_PREFIX`: `{ deviceId, meta, status, backup }`. `status` is `"complete"`, `"incomplete"` (a chunk missing, or the reassembled hash differs from `meta.hash`) or `"unknown-format"` (D13, D18). `backup` is the full backup object only when `"complete"`.
- `slotKeys(allSyncItems, deviceId)` → every key under the prefix belonging to that device.

**Acceptance:**
- Every produced item satisfies `TextEncoder` byte length of key plus `JSON.stringify(value)` at most `SYNC_QUOTA_BYTES_PER_ITEM`, asserted against the hardcoded limit written in the test, not against the budget constant.
- Real-component check: a slot of enough rules for several chunks, with Turkish characters (ç ğ ı ö ş ü), `"` and a backslash, is written to the real `browser.storage.sync`, read back with `get(null)` and decoded by `listSlots` as `"complete"` with a `backup` deep-equal to the input. The keys are removed afterwards.
- Hand-written raw fixture: a slot written in the test as literal key names and literal JSON (with a hash computed independently with Node's `crypto` and pasted in) decodes as `"complete"`. This pins the on-disk layout by something other than `encodeSlot`.
- `"incomplete"` when one chunk key is missing; when a chunk is swapped for a chunk of another encoding of the same device; when a chunk is edited so the hash differs.
- `"unknown-format"` for an unknown `format`, for `version` greater than `EXPORT_VERSION`, and for a payload `parseBackupPayload` rejects. Keys without the prefix are ignored.
- `contentHash` is equal for objects differing only in `exportedAt` and different when a pattern changes; one known vector is checked by hand.
- A single rule bigger than one item makes `encodeSlot` throw, and the message contains "too large".
- Mutation-gate the new checks.

### Task 3: Background writer

**Files:** Create `firefox/sync-backup.js`; modify `firefox/manifest.json`; test in `tests/e2e/test.js`.

**Interfaces:**
- `storage.local` keys owned by this task (grep first; none exists today): `syncBackupEnabled` (boolean, default false), `syncBackupDeviceId` (string), `syncBackupStatus` (`{ lastWrittenAt, error }`).
- Source keys, one named list shared with `buildBackupObject`'s callers: `groups`, `groupUnmatched`, `groupSortMode`, `groupColorMode`, `selectedTabTheme`.
- `var SYNC_BACKUP_DEBOUNCE_MS` — read when scheduling.
- A `storage.onChanged` listener with `areaName === "local"` schedules a write only when a source key or `syncBackupEnabled` changed. A change that touches only `syncBackupStatus`, `syncBackupDeviceId`, `groupMap` or other keys never does.
- When `sync-backup.js` loads and the toggle is on, it schedules a write (debounced, so it follows `migrateStorage` in practice). `initialize` in `background.js` does not change.
- A write run (serialized, D16):
  1. One `storage.local.get` of the source keys, `syncBackupEnabled`, `syncBackupDeviceId`. Creates the device id if missing.
  2. Groups go through `normalizeCreatedOrders(groups).groups` (the `background.js` function, called lazily) and then `buildBackupObject`. The writer never calls `getGroupsWithCreatedOrder` (it lives in `shared.js`, is not loaded in the background, and writes storage).
  3. If building throws: record the message, write nothing, stop (D17).
  4. Read this device's meta from `storage.sync`. If its `hash` equals the new hash and `active` is true: stop.
  5. `encodeSlot`, then one `storage.sync.set(items)`, then one `storage.sync.remove` of this device's keys not in `keys`.
  6. Update `syncBackupStatus` (`lastWrittenAt` on success; `error` cleared) or record the error message on failure, leaving the previous slot as it was (a rejected `set()` writes nothing).
- Toggle off: if a slot exists, rewrite only its meta with `active: false`; write no chunks; later changes write nothing.
- Label (D7): built on the first write from `getPlatformInfo().os` and the date; kept in meta afterwards.
- A rejected `set()` is handled as a status error; no tight retry loop. The next change retries.

**Acceptance:**
- Toggle on, change `groups` via the test helper `setStore` twice or more; after each change the slot decodes `"complete"` with `backup.groups` equal to the stored rules (assert after every change, not only the last).
- The writer's backup equals what `exportRules()` produces for the same storage state, ignoring `exportedAt`, for a state without settings keys and for legacy rules lacking `createdOrder`.
- Changes touching only `groupMap` and `syncBackupStatus` cause no `storage.sync` write, observed through a `storage.onChanged` listener on area `"sync"` in the test page over a wait derived from `SYNC_BACKUP_DEBOUNCE_MS`. Several rapid source changes inside one debounce window cause one write.
- Two overlapping triggers produce one device id and a coherent slot.
- Shrinking from several chunks to one leaves no extra chunk keys for this device.
- Toggle off marks `meta.active === false` and later changes do not change the slot; toggle on again rewrites it with `active: true`.
- Quota: fill `storage.sync` under a different prefix until a write would exceed the total limit. Expect `syncBackupStatus.error` set, live `groups` unchanged, the previous slot intact, and the error cleared by the next successful write. Likewise an invalid stored rule (D17) and a rule too large for one item (D14). Filler keys are removed afterwards.
- Wiring: removing `sync-backup.js` from `background.scripts` turns at least one check red.
- Every check that enables the toggle ends with the toggle off and its `storage.sync` keys removed. The knob is lowered in the test so the added waiting time keeps the whole run inside the harness wait.
- Mutation-gate the new checks.

### Task 4: Split `importRules` so restore can reuse it

**Files:** Modify `firefox/options.js`; test in `tests/e2e/test.js`.

**Interfaces:**
- `applyBackupPayload(data, mode)` in `options.js` holds everything `importRules(file)` does after `JSON.parse`: `parseBackupPayload`, the `replace` / `merge` branch (`mergeGroups`, `normalizeCreatedOrders`), the settings update, removal of `groupMap`, `loadSettings`, `refreshList`, `applyRules`, and the status messages.
- `importRules(file)` keeps the size check and the JSON parse and calls `applyBackupPayload(data, getImportMode())`.

**Acceptance:**
- `import: full importRules replace via File` and the merge check pass unchanged.
- New check: `applyBackupPayload` with `"merge"` on a plain object keeps local-only rules and adds new ones, with no `File` involved; with `"replace"` it leaves exactly the payload's rules.

### Task 5: Options "Automatic backup" section

**Files:** Modify `firefox/options.html` (new section inserted **before** the "Add New Rule" section so that form stays the last `.section`; CSS is inline in the page's `<style>`), `firefox/options.js`; test in `tests/e2e/test.js`.

**Interfaces:**
- Consumes `listSlots`, `slotKeys` (Task 2), the three `syncBackup*` keys (Task 3), `applyBackupPayload` and `getImportMode` (Task 4).
- Toggle: a checkbox writing `syncBackupEnabled`. Help text, in English, says:
  1. Backups travel through Firefox Sync, which must be signed in with "Add-ons" ticked in its settings; Sync runs about every ten minutes.
  2. Firefox for Android does not sync them.
  3. Removing the extension deletes these backups from every synced device; use Export for a backup that survives.
  4. What is copied: rule names, URL patterns, colours, the four settings, and a device label with the operating-system name, to Mozilla's Sync servers, encrypted by Firefox Sync.
  5. Turning the toggle off stops updates but leaves the last copy on the server until it is deleted from the list.
  6. Restore uses the mode chosen under "Backup & Restore".
- Status line from `syncBackupStatus`: "Saved in Firefox Sync storage" with the time, or the error. It does not say "backed up" (a local write succeeds even when Sync is off).
- Slot list: one row per `listSlots` entry showing label, `exportedAt`, rule count, "this device" on its own row, "stopped" when inactive, "incomplete" or "unknown format" when not complete. Do not reuse `#groupList`. Add a `:disabled` style for the new buttons.
  - Restore enabled only for `"complete"`; calls `applyBackupPayload(slot.backup, getImportMode())` behind `confirm()` naming the device and the mode; the result is reported in `#backupStatus` through `showStatus`, as file import does.
  - Delete removes `slotKeys(...)` behind `confirm()`; on this device's row it is enabled only while the toggle is off (D12).
- Offer (D9): when the toggle goes from off to on and at least one foreign slot already exists, the list is scrolled into view and highlighted with a line saying the user can restore from it.
- The options page's first `storage.onChanged` listener: re-renders only the slot list and status line, on area `"sync"` changes under the prefix and on `syncBackupStatus` / `syncBackupEnabled` in area `"local"`; it never writes.

**Acceptance:**
- With hand-written slots for two other devices in the real `storage.sync` (the raw fixture from Task 2, not made with `encodeSlot`), the list shows both, plus this device's slot once the toggle is on.
- Restore in `replace` mode leaves `storage.local.groups` equal to the slot's rules; in `merge` mode a local-only rule stays; the `confirm` text names the mode. (The test page stubs `confirm` to return true in `openExtensionPage`.)
- Incomplete and unknown-format rows have a disabled restore button and the page raises no uncaught error.
- Deleting another device's slot removes all its keys; this device's delete button is disabled while the toggle is on.
- D3: `storage.local.groups` is unchanged after a writer run and after a foreign slot appears. D4: `manifest.json` `permissions` equals the original list. D7: the device id is identical across two writes and the label contains the OS string from `getPlatformInfo`. D9: toggling on with a foreign slot present shows the offer element.
- Editing a rule from the options page still scrolls to `#groupForm` (`startEdit` scrolls to the last `.section`).
- Mutation-gate the new checks.

### Task 6: Manual check in two real profiles (the user runs it)

- [ ] Two Firefox profiles signed into the same Firefox Account with Add-ons sync on. Enable the toggle on A, wait for Sync (or press "Sync Now"), check that the slot appears on B and restore works; record the Firefox version and how long it took.
- [ ] Repeat with "Add-ons" sync off on one side and confirm nothing arrives.
- [ ] Uninstall the extension on A while B stays signed in and syncing; confirm after Sync whether the slot disappears on B (the claim in help text 3 rests on code reading only).

### Task 7: Documentation and release gate (separate turn, on request — not part of this run)

- README Privacy section states "Works entirely locally" and must describe the opt-in copy; `CONTRIBUTING.md` e2e scope; AMO listing, privacy-policy field and Notes for Reviewers; D19. Listed here so the release does not ship with a false privacy statement.
