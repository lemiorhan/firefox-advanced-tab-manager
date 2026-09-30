const PORT = new URLSearchParams(location.search).get("port") || "8765";
const A = `http://127.0.0.1:${PORT}`;
const B = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];

async function report(name, pass, detail) {
  const line = { name, pass, detail };
  results.push(line);
  await fetch(`${A}/result`, { method: "POST", body: JSON.stringify(line) });
}

async function check(name, fn) {
  try {
    const { pass, detail } = await fn();
    await report(name, pass, detail);
  } catch (e) {
    await report(name, false, "THREW " + e + " " + (e.stack || ""));
  }
}

let W;

async function snapshot(windowId = W) {
  const tabs = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const groups = await browser.tabGroups.query({ windowId });
  const byId = Object.fromEntries(groups.map(g => [g.id, g]));
  return tabs.map(t => ({
    path: t.url.replace(A, "A").replace(B, "B"),
    group: t.groupId === -1 ? null : byId[t.groupId]?.title,
    color: t.groupId === -1 ? null : byId[t.groupId]?.color,
    collapsed: t.groupId === -1 ? null : byId[t.groupId]?.collapsed,
    id: t.id,
    groupId: t.groupId
  }));
}

async function settle() {
  await sleep(700);
  let prev = "";
  for (let i = 0; i < 40; i++) {
    const s = JSON.stringify(await snapshot());
    if (s === prev) return;
    prev = s;
    await sleep(400);
  }
}

function groupOrder(snap) {
  const order = [];
  for (const t of snap) if (t.group && order.at(-1) !== t.group) order.push(t.group);
  return order;
}

function groupOf(snap, path) {
  return snap.find(t => t.path === path)?.group ?? null;
}

async function openTab(path, opts = {}) {
  const url = path.startsWith("http") ? path : A + path;
  const tab = await browser.tabs.create({ windowId: W, url, active: true, ...opts });
  await waitLoaded(tab.id, url);
  await settle();
  return tab;
}

async function waitLoaded(tabId, url) {
  for (let i = 0; i < 50; i++) {
    const t = await browser.tabs.get(tabId);
    if (t.url === url || t.url === url + "/") return;
    await sleep(200);
  }
  throw new Error(`tab ${tabId} never loaded ${url}`);
}

async function setStore(obj) {
  await browser.storage.local.set(obj);
}

async function applyAll() {
  await browser.runtime.sendMessage({ action: "applyRulesToAllTabs" });
  await settle();
}

async function openExtensionPage(file) {
  await browser.tabs.create({ url: browser.runtime.getURL(file), active: true });
  await sleep(1500);
  const view = browser.extension.getViews({ type: "tab" })
    .find(v => v.location.pathname === "/" + file);
  view.confirm = () => true;
  view.alert = msg => { view.__alerts = (view.__alerts || []).concat(msg); };
  return view;
}

function liFor(view, name) {
  return [...view.document.querySelectorAll("#groupList li")]
    .find(li => li.querySelector(".group-name").textContent.trim() === name);
}

async function run() {
  const bg = await browser.runtime.getBackgroundPage();

  // ---------------------------------------------------------------- matching
  await check("match: cases", async () => {
    const cases = [
      ["https://github.com/foo", "github.com", true],
      ["https://www.github.com/foo", "github.com", true],
      ["https://github.com/foo", "*.github.com/*", null],
      ["https://gist.github.com/foo", "*.github.com/*", true],
      ["https://github.com/foo", "https://github.com/*", true],
      ["https://GITHUB.com/Foo", "github.com/foo", true],
      ["https://gitlab.com/x", "*github.com*|*gitlab.com*", true],
      ["https://bitbucket.org/x", "*github.com*|*gitlab.com*", false],
      ["https://example.com/a?b=1", "example.com/a?b=1", true],
      ["https://exampleXcom/", "example.com", false],
      ["http://localhost:8080/x", "*localhost*", true],
      ["https://www.youtube.com/watch?v=1", "*youtube.com/watch*", true],
      ["https://reddit.com/r/x", "*reddit.com*", true],
      ["about:newtab", "*", true],
      ["https://a.com", "|", false]
    ];
    const out = cases.map(([u, p, exp]) => ({ u, p, exp, got: bg.wildcardMatch(u, p) }));
    const bad = out.filter(c => c.exp !== null && c.exp !== c.got);
    return { pass: bad.length === 0, detail: JSON.stringify({ bad, info: out.filter(c => c.exp === null) }) };
  });

  // ---------------------------------------------------------------- setup
  await browser.storage.local.clear();
  await setStore({
    groups: [
      { name: "Work", pattern: "*127.0.0.1*/work*", color: "blue", createdOrder: 1 },
      { name: "Docs", pattern: "*localhost*/docs*|*127.0.0.1*/docs*", color: "red", createdOrder: 2 }
    ],
    groupUnmatched: true,
    groupSortMode: "alphabetical",
    groupColorMode: "assigned"
  });
  const win = await browser.windows.create({ url: A + "/start" });
  W = win.id;
  await settle();

  await openTab("/work/1");
  await openTab("/docs/1");
  await openTab("/other/1");
  await openTab("/work/2");
  await openTab(B + "/docs/2");

  await check("group: tabs join rule groups with name(count) and color", async () => {
    const s = await snapshot();
    const ok =
      groupOf(s, "A/work/1") === "Work(2)" &&
      groupOf(s, "A/work/2") === "Work(2)" &&
      groupOf(s, "A/docs/1") === "Docs(2)" &&
      groupOf(s, "B/docs/2") === "Docs(2)" &&
      s.find(t => t.path === "A/work/1").color === "blue" &&
      s.find(t => t.path === "A/docs/1").color === "red";
    return { pass: ok, detail: JSON.stringify(s.map(({ path, group, color }) => [path, group, color])) };
  });

  await check("etc: unmatched tabs go to grey etc group", async () => {
    const s = await snapshot();
    const t = s.find(t => t.path === "A/other/1");
    return { pass: /^etc\(\d+\)$/.test(t.group) && t.color === "grey", detail: JSON.stringify(t) };
  });

  await check("sort: alphabetical order in tab bar", async () => {
    const o = groupOrder(await snapshot()).map(g => g.replace(/\(\d+\)$/, ""));
    return { pass: JSON.stringify(o) === JSON.stringify(["Docs", "etc", "Work"]), detail: JSON.stringify(o) };
  });

  // link-opened tab: must not detour through etc
  {
    // Polls from before tabs.create, so a group state that appears before
    // the create call resolves is still recorded.
    const openLinkTab = async (path, openerPath) => {
      const before = new Set((await snapshot()).map(t => t.id));
      const opener = (await snapshot()).find(t => t.path === openerPath);
      const groups = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          for (const t of await snapshot()) {
            if (!before.has(t.id)) groups.push(t.group);
          }
          await sleep(20);
        }
      })();
      const child = await browser.tabs.create({ windowId: W, url: A + path, openerTabId: opener.id, active: false });
      await waitLoaded(child.id, A + path);
      await settle();
      sampling = false;
      await sampler;
      return { child, groups };
    };

    const link1 = await openLinkTab("/work/link", "A/work/1");
    await check("link tab: tab opened from a Work tab never passes through etc", async () => {
      const s = await snapshot();
      const detour = link1.groups.some(g => g?.startsWith("etc("));
      return { pass: link1.groups.length > 0 && !detour && groupOf(s, "A/work/link") === "Work(3)", detail: JSON.stringify(link1.groups) };
    });
    await browser.tabs.remove(link1.child.id);
    await settle();

    const link2 = await openLinkTab("/work/link2", "A/docs/1");
    await check("link tab: tab opened from a Docs tab to a Work URL ends in Work, never etc", async () => {
      const s = await snapshot();
      const detour = link2.groups.some(g => g?.startsWith("etc("));
      return { pass: link2.groups.length > 0 && !detour && groupOf(s, "A/work/link2") === "Work(3)", detail: JSON.stringify(link2.groups) };
    });
    await browser.tabs.remove(link2.child.id);
    await settle();

    const blank = await browser.tabs.create({ windowId: W, url: "about:blank", active: true });
    await settle();
    await check("blank tab: a tab that stays on about:blank lands in etc", async () => {
      const t = (await snapshot()).find(t => t.id === blank.id);
      return { pass: !!t?.group?.startsWith("etc("), detail: JSON.stringify(t) };
    });
    await browser.tabs.remove(blank.id);
    await settle();
  }

  // navigate away
  const s0 = await snapshot();
  const work2 = s0.find(t => t.path === "A/work/2");
  await browser.tabs.update(work2.id, { url: A + "/other/2", active: true });
  await waitLoaded(work2.id, A + "/other/2");
  await settle();
  await check("navigate: leaving pattern moves tab and updates counts", async () => {
    const s = await snapshot();
    const etcCount = s.filter(t => t.group?.startsWith("etc(")).length;
    const ok = groupOf(s, "A/work/1") === "Work(1)" &&
      groupOf(s, "A/other/2") === `etc(${etcCount})`;
    return { pass: ok, detail: JSON.stringify(s.map(({ path, group }) => [path, group])) };
  });

  // close a tab
  const docs2 = (await snapshot()).find(t => t.path === "B/docs/2");
  await browser.tabs.remove(docs2.id);
  await settle();
  await check("close: closing a tab decrements count", async () => {
    const s = await snapshot();
    return { pass: groupOf(s, "A/docs/1") === "Docs(1)", detail: JSON.stringify(s.map(({ path, group }) => [path, group])) };
  });

  // new empty tab
  await browser.tabs.create({ windowId: W, active: true });
  await settle();
  await check("new tab: about:newtab lands in etc", async () => {
    const s = await snapshot();
    const t = s.find(t => t.path.startsWith("about:"));
    return { pass: !!t?.group?.startsWith("etc("), detail: JSON.stringify(t) };
  });

  // user-created group untouched?
  const mine = await openTab("/work/mine");
  const mineGroup = await browser.tabs.group({ tabIds: [mine.id], createProperties: { windowId: W } });
  await browser.tabGroups.update(mineGroup, { title: "Mine", color: "pink" });
  await settle();
  await check("user group: a tab put into a user-titled group stays there (info)", async () => {
    const s = await snapshot();
    return { pass: true, detail: JSON.stringify(s.find(t => t.path === "A/work/mine")) };
  });
  await applyAll();
  await check("user group: after reapply (info)", async () => {
    const s = await snapshot();
    const gs = await browser.tabGroups.query({ windowId: W });
    return { pass: true, detail: JSON.stringify({ tab: s.find(t => t.path === "A/work/mine"), groups: gs.map(g => g.title) }) };
  });

  // groupUnmatched off
  await setStore({ groupUnmatched: false });
  await applyAll();
  await check("etc off: unmatched tabs ungrouped", async () => {
    const s = await snapshot();
    const ok = groupOf(s, "A/other/1") === null && groupOf(s, "A/other/2") === null && !s.some(t => t.group?.startsWith("etc"));
    return { pass: ok, detail: JSON.stringify(s.map(({ path, group }) => [path, group])) };
  });
  await setStore({ groupUnmatched: true });
  await applyAll();

  // ---------------------------------------------------------------- options page
  const opt = await openExtensionPage("options.html");

  await check("options: rule list is in storage order with move buttons", async () => {
    const names = [...opt.document.querySelectorAll("#groupList li .group-name")].map(n => n.textContent.trim());
    const moves = opt.document.querySelectorAll("#groupList .move-btn").length;
    const firstUp = liFor(opt, "Work").querySelector(".move-btn").disabled;
    return { pass: JSON.stringify(names) === '["Work","Docs"]' && moves === 4 && firstUp, detail: JSON.stringify({ names, moves, firstUp }) };
  });

  await check("options: settings controls reflect storage", async () => {
    const d = opt.document;
    const v = [d.getElementById("groupUnmatched").checked, d.getElementById("groupSortMode").value, d.getElementById("groupColorMode").value, d.getElementById("selectedTabTheme").checked];
    return { pass: JSON.stringify(v) === '[true,"alphabetical","assigned",false]', detail: JSON.stringify(v) };
  });

  // add a broad rule via the form
  opt.document.getElementById("name").value = "Local";
  opt.document.getElementById("pattern").value = "*127.0.0.1*";
  opt.document.getElementById("color").value = "green";
  opt.document.getElementById("submitBtn").click();
  await sleep(500);
  await settle();
  await check("options add: new broad rule appended, lower priority than Work", async () => {
    const { groups } = await browser.storage.local.get("groups");
    const s = await snapshot();
    const ok = groups.map(g => g.name).join() === "Work,Docs,Local" &&
      groupOf(s, "A/work/1") === "Work(2)" && groupOf(s, "A/other/1")?.startsWith("Local(");
    return { pass: ok, detail: JSON.stringify({ rules: groups.map(g => [g.name, g.createdOrder]), s: s.map(({ path, group }) => [path, group]) }) };
  });

  await check("options add: duplicate name rejected", async () => {
    opt.document.getElementById("name").value = "work";
    opt.document.getElementById("pattern").value = "*x*";
    opt.__alerts = [];
    opt.document.getElementById("submitBtn").click();
    await sleep(500);
    const { groups } = await browser.storage.local.get("groups");
    opt.document.getElementById("groupForm").reset();
    return { pass: groups.length === 3 && opt.__alerts.length === 1, detail: JSON.stringify(opt.__alerts) };
  });

  // move Local to top via UI
  liFor(opt, "Local").querySelectorAll(".move-btn")[0].click();
  await sleep(500);
  liFor(opt, "Local").querySelectorAll(".move-btn")[0].click();
  await sleep(500);
  await settle();
  await check("options reorder: moving broad rule to top takes priority", async () => {
    const { groups } = await browser.storage.local.get("groups");
    const s = await snapshot();
    const names = [...opt.document.querySelectorAll("#groupList li .group-name")].map(n => n.textContent.trim());
    const ok = groups.map(g => g.name).join() === "Local,Work,Docs" &&
      names.join() === "Local,Work,Docs" &&
      groupOf(s, "A/work/1")?.startsWith("Local(") &&
      !s.some(t => t.group?.startsWith("Work("));
    return { pass: ok, detail: JSON.stringify({ rules: groups.map(g => g.name), names, s: s.map(({ path, group }) => [path, group]) }) };
  });

  // move it back down twice
  liFor(opt, "Local").querySelectorAll(".move-btn")[1].click();
  await sleep(500);
  liFor(opt, "Local").querySelectorAll(".move-btn")[1].click();
  await sleep(500);
  await settle();
  await check("options reorder: moving down restores priority", async () => {
    const { groups } = await browser.storage.local.get("groups");
    const s = await snapshot();
    return { pass: groups.map(g => g.name).join() === "Work,Docs,Local" && groupOf(s, "A/work/1") === "Work(2)", detail: JSON.stringify(s.map(({ path, group }) => [path, group])) };
  });

  // edit Work: color green->? use yellow, and rename
  liFor(opt, "Work").querySelector(".edit-btn").click();
  await sleep(200);
  opt.document.getElementById("color").value = "yellow";
  opt.document.getElementById("submitBtn").click();
  await sleep(500);
  await settle();
  await check("options edit: assigned color change recolors open group", async () => {
    const s = await snapshot();
    const t = s.find(t => t.path === "A/work/1");
    return { pass: t.color === "yellow", detail: JSON.stringify(t) };
  });

  liFor(opt, "Work").querySelector(".edit-btn").click();
  await sleep(200);
  opt.document.getElementById("name").value = "Job";
  opt.document.getElementById("submitBtn").click();
  await sleep(500);
  await settle();
  await check("options edit: rename moves tabs to new group title", async () => {
    const s = await snapshot();
    const gs = await browser.tabGroups.query({ windowId: W });
    return { pass: groupOf(s, "A/work/1") === "Job(2)" && !gs.some(g => g.title.startsWith("Work")), detail: JSON.stringify(gs.map(g => g.title)) };
  });

  // gray color from UI maps to grey
  liFor(opt, "Docs").querySelector(".edit-btn").click();
  await sleep(200);
  opt.document.getElementById("color").value = "gray";
  opt.document.getElementById("submitBtn").click();
  await sleep(500);
  await settle();
  await check("options edit: 'gray' in UI becomes Firefox 'grey'", async () => {
    const s = await snapshot();
    return { pass: s.find(t => t.path === "A/docs/1").color === "grey", detail: JSON.stringify(s.find(t => t.path === "A/docs/1")) };
  });

  // sort mode creation via UI
  const sortSel = opt.document.getElementById("groupSortMode");
  sortSel.value = "creation";
  sortSel.dispatchEvent(new opt.Event("change"));
  await sleep(500);
  await settle();
  await check("sort: creation order in tab bar (etc last)", async () => {
    const o = groupOrder(await snapshot()).map(g => g.replace(/\(\d+\)$/, ""));
    // Job createdOrder 1, Docs 2, Local 3, Mine unmanaged
    const managed = o.filter(n => n !== "Mine");
    return { pass: JSON.stringify(managed) === '["Job","Docs","Local","etc"]', detail: JSON.stringify(o) };
  });

  // delete via UI
  liFor(opt, "Local").querySelector(".delete-btn").click();
  await sleep(500);
  await settle();
  await check("options delete: rule removed and tabs reapplied", async () => {
    const { groups } = await browser.storage.local.get("groups");
    const s = await snapshot();
    return { pass: groups.map(g => g.name).join() === "Job,Docs" && groupOf(s, "A/other/1")?.startsWith("etc("), detail: JSON.stringify(s.map(({ path, group }) => [path, group])) };
  });

  // ---------------------------------------------------------------- popup page
  const pop = await openExtensionPage("popup.html");
  await check("popup: list follows sort mode and has no move buttons", async () => {
    const names = [...pop.document.querySelectorAll("#groupList li .group-name")].map(n => n.textContent.trim());
    return { pass: names.join() === "Job,Docs" && pop.document.querySelectorAll(".move-btn").length === 0, detail: JSON.stringify(names) };
  });
  pop.document.getElementById("name").value = "Alpha";
  pop.document.getElementById("pattern").value = "*127.0.0.1*/other*";
  pop.document.getElementById("color").value = "purple";
  pop.document.getElementById("submitBtn").click();
  await sleep(500);
  await settle();
  await check("popup add: rule saved and applied", async () => {
    const s = await snapshot();
    const t = s.find(t => t.path === "A/other/1");
    return { pass: t.group === "Alpha(2)" && t.color === "purple", detail: JSON.stringify(t) };
  });
  await check("popup: creation mode lists newest last", async () => {
    await pop.refreshList("groupList");
    const names = [...pop.document.querySelectorAll("#groupList li .group-name")].map(n => n.textContent.trim());
    return { pass: names.join() === "Job,Docs,Alpha", detail: JSON.stringify(names) };
  });
  await setStore({ groupSortMode: "alphabetical" });
  await check("popup: alphabetical mode lists by name", async () => {
    await pop.refreshList("groupList");
    const names = [...pop.document.querySelectorAll("#groupList li .group-name")].map(n => n.textContent.trim());
    return { pass: names.join() === "Alpha,Docs,Job", detail: JSON.stringify(names) };
  });
  await browser.runtime.sendMessage({ action: "sortAllGroups" });
  await settle();
  await check("sort: sortAllGroups message reorders back to alphabetical", async () => {
    const o = groupOrder(await snapshot()).map(g => g.replace(/\(\d+\)$/, "")).filter(n => n !== "Mine");
    return { pass: o.join() === "Alpha,Docs,etc,Job", detail: JSON.stringify(o) };
  });

  // ---------------------------------------------------------------- collapse / expand
  const jobTab = (await snapshot()).find(t => t.path === "A/work/1");
  await browser.tabGroups.update(jobTab.groupId, { collapsed: true });
  await sleep(300);
  const w3 = await browser.tabs.create({ windowId: W, url: A + "/work/3", active: true });
  await waitLoaded(w3.id, A + "/work/3");
  await settle();
  await check("expand: active tab joining a collapsed group expands it", async () => {
    const s = await snapshot();
    const t = s.find(t => t.path === "A/work/3");
    return { pass: t.group === "Job(3)" && t.collapsed === false, detail: JSON.stringify(t) };
  });

  // ---------------------------------------------------------------- theme
  await setStore({ selectedTabTheme: true });
  await settle();
  const s1 = await snapshot();
  await browser.tabs.update(s1.find(t => t.path === "A/work/3").id, { active: true });
  await settle();
  await check("theme: selected grouped tab gets tab_selected of group color", async () => {
    const theme = await browser.theme.getCurrent(W);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const exp = dark ? "#5f3100" : "#fde8b5"; // Job is yellow
    return { pass: theme?.colors?.tab_selected === exp, detail: JSON.stringify({ dark, tab_selected: theme?.colors?.tab_selected }) };
  });
  await browser.tabs.update(s1.find(t => t.path === "A/work/mine").id, { active: true });
  await settle();
  await check("theme: selecting a tab in a non-managed group (info)", async () => {
    const theme = await browser.theme.getCurrent(W);
    return { pass: true, detail: JSON.stringify(theme?.colors?.tab_selected ?? null) };
  });
  await setStore({ selectedTabTheme: false });
  await settle();
  await check("theme: turning setting off resets window theme", async () => {
    const theme = await browser.theme.getCurrent(W);
    return { pass: !theme?.colors?.tab_selected, detail: JSON.stringify(theme?.colors ?? null) };
  });

  // ---------------------------------------------------------------- random colors
  const many = [];
  for (let i = 0; i < 11; i++) many.push({ name: `R${String(i).padStart(2, "0")}`, pattern: `*127.0.0.1*/r${i}/*`, color: "blue", createdOrder: i + 1 });
  await setStore({ groups: many, groupSortMode: "alphabetical" });
  for (let i = 0; i < 11; i++) await openTab(`/r${i}/x`);
  await settle();
  await applyAll();
  await check("assigned mode: all rule groups blue", async () => {
    const s = await snapshot();
    const colors = [...new Set(s.filter(t => t.group?.startsWith("R")).map(t => t.color))];
    return { pass: colors.join() === "blue", detail: JSON.stringify(colors) };
  });
  const colorSel = opt.document.getElementById("groupColorMode");
  await opt.loadSettings();
  colorSel.value = "random";
  colorSel.dispatchEvent(new opt.Event("change"));
  await sleep(800);
  await settle();
  const adjacentCheck = async () => {
    const s = await snapshot();
    const seq = [];
    for (const t of s) if (t.groupId !== -1 && seq.at(-1)?.id !== t.groupId) seq.push({ id: t.groupId, title: t.group, color: t.color });
    const clashes = [];
    for (let i = 1; i < seq.length; i++) if (seq[i].color === seq[i - 1].color) clashes.push([seq[i - 1].title, seq[i].title, seq[i].color]);
    return { seq, clashes };
  };
  await check("random mode: groups recolored, no adjacent same color", async () => {
    const { seq, clashes } = await adjacentCheck();
    const distinct = new Set(seq.map(g => g.color)).size;
    return { pass: clashes.length === 0 && distinct > 1, detail: JSON.stringify({ clashes, seq: seq.map(g => [g.title, g.color]) }) };
  });
  await check("random mode: unmanaged group 'Mine' (info)", async () => {
    const gs = await browser.tabGroups.query({ windowId: W });
    const m = gs.find(g => g.title === "Mine");
    return { pass: true, detail: JSON.stringify(m ?? "Mine group gone") };
  });
  const before = JSON.stringify((await adjacentCheck()).seq);
  await applyAll();
  await check("random mode: reapplying rules keeps colors stable", async () => {
    const after = JSON.stringify((await adjacentCheck()).seq);
    return { pass: before === after, detail: before === after ? "" : JSON.stringify({ before, after }) };
  });
  for (let i = 11; i < 14; i++) {
    many.push({ name: `R${i}`, pattern: `*127.0.0.1*/r${i}/*`, color: "blue", createdOrder: i + 1 });
  }
  await setStore({ groups: many });
  for (let i = 11; i < 14; i++) await openTab(`/r${i}/x`);
  await check("random mode: new groups also avoid adjacent clash", async () => {
    const { clashes, seq } = await adjacentCheck();
    return { pass: clashes.length === 0, detail: JSON.stringify({ clashes, seq: seq.map(g => [g.title, g.color]) }) };
  });

  // ---------------------------------------------------------------- export / import
  await check("export: produces JSON backup with schema and settings", async () => {
    let href = null, filename = null;
    const orig = opt.HTMLAnchorElement.prototype.click;
    opt.HTMLAnchorElement.prototype.click = function () { href = this.href; filename = this.download; };
    await opt.exportRules();
    opt.HTMLAnchorElement.prototype.click = orig;
    const text = await (await opt.fetch(href)).text();
    const data = JSON.parse(text);
    return { pass: data.schema === "advanced-tab-manager" && /^advanced-tab-manager-rules-.*\.json$/.test(filename) && data.groups.length === many.length && data.settings.groupColorMode === "random", detail: JSON.stringify({ filename, schema: data.schema, version: data.version, settings: data.settings }) };
  });
  await check("import: parse legacy raw array and schema object", async () => {
    const a = opt.parseBackupPayload([{ name: "X", pattern: "*x*", color: "grey" }]);
    const b = opt.parseBackupPayload({ schema: "auto-group-tabs", version: 2, settings: { groupSortMode: "creation" }, groups: [{ name: "Y", pattern: "*y*" }] });
    const c = opt.parseBackupPayload({ schema: "advanced-tab-manager", version: 2, groups: [{ name: "N", pattern: "*n*" }] });
    if (c.groups[0].name !== "N") throw new Error("new schema not parsed");
    let rejected = false;
    try { opt.parseBackupPayload({ schema: "other", groups: [] }); } catch { rejected = true; }
    let dup = false;
    try { opt.parseBackupPayload([{ name: "Z", pattern: "a" }, { name: "z", pattern: "b" }]); } catch { dup = true; }
    return { pass: a.groups[0].color === "gray" && b.groups[0].color === "blue" && b.groupSortMode === "creation" && rejected && dup, detail: JSON.stringify({ a, b }) };
  });
  await check("import: merge keeps local order and updates same-name rule", async () => {
    const merged = opt.mergeGroups(
      [{ name: "A", pattern: "a", color: "red", createdOrder: 5 }, { name: "B", pattern: "b", color: "red", createdOrder: 6 }],
      [{ name: "b", pattern: "bb", color: "green" }, { name: "C", pattern: "c", color: "cyan" }]
    );
    return { pass: JSON.stringify(merged.map(r => [r.name, r.pattern, r.createdOrder])) === '[["A","a",5],["b","bb",6],["C","c",7]]', detail: JSON.stringify(merged) };
  });
  await check("import: full importRules replace via File", async () => {
    const file = new opt.File([JSON.stringify({ schema: "auto-group-tabs", version: 2, settings: { groupUnmatched: false, groupColorMode: "assigned", groupSortMode: "alphabetical", selectedTabTheme: false }, groups: [{ name: "Only", pattern: "*127.0.0.1*/work*", color: "cyan" }] })], "b.json", { type: "application/json" });
    await opt.importRules(file);
    await settle();
    const st = await browser.storage.local.get(null);
    const s = await snapshot();
    const status = opt.document.getElementById("backupStatus").textContent;
    return { pass: st.groups.length === 1 && st.groupUnmatched === false && groupOf(s, "A/work/1") === "Only(3)" && s.find(t => t.path === "A/work/1").color === "cyan", detail: JSON.stringify({ status, groups: st.groups, s: s.map(({ path, group }) => [path, group]).slice(0, 6) }) };
  });

  // ---------------------------------------------------------------- detach
  const w2 = await browser.windows.create({});
  const moveTab = (await snapshot()).find(t => t.path === "A/work/3");
  await browser.tabs.move(moveTab.id, { windowId: w2.id, index: -1 });
  await settle();
  await check("detach: moving a tab to another window updates counts in both", async () => {
    const s = await snapshot();
    const s2 = await snapshot(w2.id);
    return { pass: groupOf(s, "A/work/1") === "Only(2)" && groupOf(s2, "A/work/3") === "Only(1)", detail: JSON.stringify({ s: s.find(t => t.path === "A/work/1"), s2 }) };
  });

  const asserted = results.filter(r => !r.name.endsWith("(info)"));
  await report("DONE", results.filter(r => !r.pass && r.name !== "DONE").length === 0, `${asserted.length} checks, ${results.length - asserted.length} info rows`);
}

run().catch(e => report("HARNESS", false, String(e) + e.stack));
