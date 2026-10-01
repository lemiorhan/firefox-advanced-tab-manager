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

async function captureExport(view) {
  let href = null;
  const orig = view.HTMLAnchorElement.prototype.click;
  view.HTMLAnchorElement.prototype.click = function () { href = this.href; };
  try {
    await view.exportRules();
  } finally {
    view.HTMLAnchorElement.prototype.click = orig;
  }
  return (await view.fetch(href)).text();
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
  // ---------------------------------------------------------------- backup format
  const AT = "2026-01-02T03:04:05.000Z";
  const head = `{"schema":"advanced-tab-manager","version":2,"exportedAt":"${AT}","settings":`;
  const workRule = [{ name: "Work", pattern: "*work*", color: "blue", createdOrder: 1 }];
  const workJson = '[{"name":"Work","pattern":"*work*","color":"blue","createdOrder":1}]';

  await check("backup: wiring reaches both pages", async () => {
    const seen = {
      bgBuild: typeof bg.buildBackupObject,
      optBuild: typeof opt.buildBackupObject,
      optParse: typeof opt.parseBackupPayload,
      bgSettings: typeof bg.getSettings
    };
    return { pass: Object.values(seen).every(t => t === "function"), detail: JSON.stringify(seen) };
  });

  await check("backup: buildBackupObject fills defaults for missing settings", async () => {
    const got = JSON.stringify(opt.buildBackupObject(workRule, {}, AT));
    const exp = head + '{"groupUnmatched":true,"groupSortMode":"alphabetical","groupColorMode":"assigned","selectedTabTheme":false},"groups":' + workJson + "}";
    return { pass: got === exp, detail: got };
  });

  await check("backup: buildBackupObject keeps valid non-default settings", async () => {
    const got = JSON.stringify(opt.buildBackupObject(workRule, { groupUnmatched: false, groupSortMode: "creation", groupColorMode: "random", selectedTabTheme: true }, AT));
    const exp = head + '{"groupUnmatched":false,"groupSortMode":"creation","groupColorMode":"random","selectedTabTheme":true},"groups":' + workJson + "}";
    return { pass: got === exp, detail: got };
  });

  await check("backup: buildBackupObject normalizes bad sort mode, color mode and theme", async () => {
    const cases = [
      [{ groupSortMode: "bogus", groupColorMode: "bogus", selectedTabTheme: "true" }, '{"groupUnmatched":true,"groupSortMode":"alphabetical","groupColorMode":"assigned","selectedTabTheme":false}'],
      [{ groupSortMode: 7, groupColorMode: null, selectedTabTheme: 1 }, '{"groupUnmatched":true,"groupSortMode":"alphabetical","groupColorMode":"assigned","selectedTabTheme":false}']
    ];
    const bad = cases
      .map(([settings, exp]) => ({ got: JSON.stringify(opt.buildBackupObject(workRule, settings, AT)), exp: head + exp + ',"groups":' + workJson + "}" }))
      .filter(c => c.got !== c.exp);
    return { pass: bad.length === 0, detail: JSON.stringify(bad) };
  });

  await check("backup: buildBackupObject passes a non-boolean groupUnmatched through as exportRules always did", async () => {
    const cases = [["yes", '"yes"'], [null, "null"], [0, "0"]];
    const bad = cases
      .map(([value, text]) => ({
        got: JSON.stringify(opt.buildBackupObject(workRule, { groupUnmatched: value }, AT)),
        exp: head + `{"groupUnmatched":${text},"groupSortMode":"alphabetical","groupColorMode":"assigned","selectedTabTheme":false},"groups":` + workJson + "}"
      }))
      .filter(c => c.got !== c.exp);
    return { pass: bad.length === 0, detail: JSON.stringify(bad) };
  });

  await check("backup: buildBackupObject normalizes rules (grey to gray, trim, unknown color, extra keys)", async () => {
    const rules = [
      { name: " Work ", pattern: " *work* ", color: "grey", createdOrder: 3, extra: "dropped" },
      { name: "Docs", pattern: "*docs*", color: " Red ", createdOrder: 1 },
      { name: "Odd", pattern: "*odd*", color: "fuchsia" },
      { name: "Zero", pattern: "*zero*", color: "blue", createdOrder: 0 },
      { name: "Frac", pattern: "*frac*", color: "blue", createdOrder: 1.5 }
    ];
    const got = JSON.stringify(opt.buildBackupObject(rules, {}, AT).groups);
    const exp = '[{"name":"Work","pattern":"*work*","color":"gray","createdOrder":3},{"name":"Docs","pattern":"*docs*","color":"red","createdOrder":1},{"name":"Odd","pattern":"*odd*","color":"blue"},{"name":"Zero","pattern":"*zero*","color":"blue"},{"name":"Frac","pattern":"*frac*","color":"blue"}]';
    return { pass: got === exp, detail: got };
  });

  await check("backup: buildBackupObject throws on an invalid rule and names it", async () => {
    const cases = [
      [[{ name: "A", pattern: "*a*", color: "blue", createdOrder: 1 }, { pattern: "*b*" }], "Rule 2 has no group name."],
      [[{ name: "B", pattern: "   " }], 'Rule "B" has no URL pattern.'],
      [["x"], "Rule 1 is not a valid object."],
      [[null], "Rule 1 is not a valid object."],
      [[[]], "Rule 1 is not a valid object."]
    ];
    const bad = [];
    for (const [rules, message] of cases) {
      let got = null;
      try { opt.buildBackupObject(rules, {}, AT); got = "did not throw"; } catch (e) { got = e.message; }
      if (got !== message) bad.push({ got, message });
    }
    return { pass: bad.length === 0, detail: JSON.stringify(bad) };
  });

  await check("export: file is exactly the hand-written backup for a known storage state", async () => {
    let text;
    try {
      await setStore({
        groups: [
          { name: "Alpha", pattern: "*alpha*", color: "cyan", createdOrder: 2 },
          { name: "Legacy", pattern: "*legacy*", color: "red" }
        ],
        groupUnmatched: false,
        groupSortMode: "creation",
        groupColorMode: "random",
        selectedTabTheme: true
      });
      text = await captureExport(opt);
    } finally {
      await setStore({ groups: many, groupUnmatched: true, groupSortMode: "alphabetical", groupColorMode: "random", selectedTabTheme: false });
    }
    const exportedAt = JSON.parse(text).exportedAt;
    const exp = [
      "{",
      '  "schema": "advanced-tab-manager",',
      '  "version": 2,',
      `  "exportedAt": ${JSON.stringify(exportedAt)},`,
      '  "settings": {',
      '    "groupUnmatched": false,',
      '    "groupSortMode": "creation",',
      '    "groupColorMode": "random",',
      '    "selectedTabTheme": true',
      "  },",
      '  "groups": [',
      "    {",
      '      "name": "Alpha",',
      '      "pattern": "*alpha*",',
      '      "color": "cyan",',
      '      "createdOrder": 2',
      "    },",
      "    {",
      '      "name": "Legacy",',
      '      "pattern": "*legacy*",',
      '      "color": "red",',
      '      "createdOrder": 3',
      "    }",
      "  ]",
      "}"
    ].join("\n");
    const fresh = Math.abs(Date.now() - Date.parse(exportedAt)) < 60000 && new Date(exportedAt).toISOString() === exportedAt;
    const statusEl = opt.document.getElementById("backupStatus");
    const status = `${statusEl.className}: ${statusEl.textContent}`;
    return { pass: text === exp && fresh && status === "status success: Exported 2 rule(s).", detail: JSON.stringify({ text, fresh, status }) };
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

  // ---------------------------------------------------------------- applyBackupPayload
  {
    const KEYS = ["groups", "groupUnmatched", "groupSortMode", "groupColorMode", "selectedTabTheme"];
    const saved = await browser.storage.local.get(KEYS);
    const realApplyRules = opt.applyRules;
    let applyCalls = 0;
    let applyOk = true;
    opt.applyRules = async () => {
      applyCalls++;
      if (!applyOk) opt.showStatus("stub: tabs could not be reorganized", "error");
      return applyOk;
    };
    const setMode = mode => { opt.document.querySelector(`input[name="importMode"][value="${mode}"]`).checked = true; };
    const SEED_SETTINGS = [true, "alphabetical", "assigned", false];
    // Every value differs from SEED_SETTINGS: over a device that already holds the defaults, a guard that drops a default value changes nothing visible.
    const CUSTOM_SETTINGS = [false, "creation", "random", true];
    const SEED_GROUPS = '[{"name":"Keep","pattern":"*keep.invalid*","color":"red","createdOrder":4},{"name":"Shared","pattern":"*old.invalid*","color":"blue","createdOrder":9}]';
    const seed = async (settings = SEED_SETTINGS) => {
      const [groupUnmatched, groupSortMode, groupColorMode, selectedTabTheme] = settings;
      await setStore({
        groups: [
          { name: "Keep", pattern: "*keep.invalid*", color: "red", createdOrder: 4 },
          { name: "Shared", pattern: "*old.invalid*", color: "blue", createdOrder: 9 }
        ],
        groupUnmatched,
        groupSortMode,
        groupColorMode,
        selectedTabTheme,
        groupMap: { stale: 1 }
      });
      await opt.loadSettings();
      await opt.refreshList("groupList");
      opt.clearStatus();
      applyCalls = 0;
    };
    const observe = async () => {
      const st = await browser.storage.local.get([...KEYS, "groupMap"]);
      const d = opt.document;
      const el = d.getElementById("backupStatus");
      return {
        groups: JSON.stringify(st.groups),
        settings: [st.groupUnmatched, st.groupSortMode, st.groupColorMode, st.selectedTabTheme],
        controls: [d.getElementById("groupUnmatched").checked, d.getElementById("groupSortMode").value, d.getElementById("groupColorMode").value, d.getElementById("selectedTabTheme").checked],
        groupMap: st.groupMap ?? null,
        list: [...d.querySelectorAll("#groupList li .group-name")].map(n => n.textContent.trim()),
        status: `${el.className}: ${el.textContent}`,
        applyCalls
      };
    };
    const mismatches = (label, got, exp) => Object.keys(exp)
      .filter(k => JSON.stringify(got[k]) !== JSON.stringify(exp[k]))
      .map(k => ({ label, key: k, got: got[k], exp: exp[k] }));
    const drive = async (applyIt, applyResult = true, seedSettings) => {
      await seed(seedSettings);
      applyOk = applyResult;
      const groupWrites = [];
      const onChanged = (changes, area) => {
        const written = changes.groups && JSON.stringify(changes.groups.newValue);
        if (area === "local" && written && written !== SEED_GROUPS) groupWrites.push(written);
      };
      browser.storage.onChanged.addListener(onChanged);
      let thrown = null;
      try {
        await applyIt();
        await sleep(50);
      } catch (e) {
        thrown = String(e);
      } finally {
        browser.storage.onChanged.removeListener(onChanged);
      }
      return { thrown, got: { ...(await observe()), groupWrites } };
    };

    const CASES = [
      {
        label: "merge, all four settings",
        mode: "merge",
        payload: {
          schema: "advanced-tab-manager",
          version: 2,
          settings: { groupUnmatched: false, groupSortMode: "creation", groupColorMode: "random", selectedTabTheme: true },
          groups: [
            { name: "shared", pattern: "*new.invalid*", color: "green" },
            { name: "Fresh", pattern: "*fresh.invalid*", color: "cyan" }
          ]
        },
        groups: '[{"name":"Keep","pattern":"*keep.invalid*","color":"red","createdOrder":4},{"name":"shared","pattern":"*new.invalid*","color":"green","createdOrder":9},{"name":"Fresh","pattern":"*fresh.invalid*","color":"cyan","createdOrder":10}]',
        settings: [false, "creation", "random", true],
        list: ["Keep", "shared", "Fresh"],
        status: "status success: Import complete. 2 rule(s) imported, 3 rule(s) now configured."
      },
      {
        label: "replace, all four settings",
        mode: "replace",
        payload: {
          schema: "advanced-tab-manager",
          version: 2,
          settings: { groupUnmatched: false, groupSortMode: "creation", groupColorMode: "random", selectedTabTheme: true },
          groups: [
            { name: "Alpha", pattern: "*alpha.invalid*", color: "yellow", createdOrder: 7 },
            { name: "Beta", pattern: "*beta.invalid*", color: "gray" }
          ]
        },
        groups: '[{"name":"Alpha","pattern":"*alpha.invalid*","color":"yellow","createdOrder":7},{"name":"Beta","pattern":"*beta.invalid*","color":"gray","createdOrder":8}]',
        settings: [false, "creation", "random", true],
        list: ["Alpha", "Beta"],
        status: "status success: Import complete. 2 rule(s) restored."
      },
      {
        label: "replace, raw array without settings",
        mode: "replace",
        payload: [{ name: "Solo", pattern: "*solo.invalid*" }],
        groups: '[{"name":"Solo","pattern":"*solo.invalid*","color":"blue","createdOrder":1}]',
        settings: SEED_SETTINGS,
        list: ["Solo"],
        status: "status success: Import complete. 1 rule(s) restored."
      },
      {
        label: "merge, legacy schema with one setting, tabs could not be reorganized",
        mode: "merge",
        applyOk: false,
        payload: {
          schema: "auto-group-tabs",
          version: 2,
          settings: { groupSortMode: "creation" },
          groups: [{ name: "Late", pattern: "*late.invalid*", color: "pink" }]
        },
        groups: '[{"name":"Keep","pattern":"*keep.invalid*","color":"red","createdOrder":4},{"name":"Shared","pattern":"*old.invalid*","color":"blue","createdOrder":9},{"name":"Late","pattern":"*late.invalid*","color":"pink","createdOrder":10}]',
        settings: [true, "creation", "assigned", false],
        list: ["Keep", "Shared", "Late"],
        status: "status error: stub: tabs could not be reorganized"
      },
      {
        label: "replace, payload carries the default of every setting over a customised device",
        mode: "replace",
        seedSettings: CUSTOM_SETTINGS,
        payload: {
          schema: "advanced-tab-manager",
          version: 2,
          settings: { groupUnmatched: true, groupSortMode: "alphabetical", groupColorMode: "assigned", selectedTabTheme: false },
          groups: [
            { name: "Gamma", pattern: "*gamma.invalid*", color: "purple", createdOrder: 3 },
            { name: "Delta", pattern: "*delta.invalid*", color: "orange" }
          ]
        },
        groups: '[{"name":"Gamma","pattern":"*gamma.invalid*","color":"purple","createdOrder":3},{"name":"Delta","pattern":"*delta.invalid*","color":"orange","createdOrder":4}]',
        settings: SEED_SETTINGS,
        list: ["Gamma", "Delta"],
        status: "status success: Import complete. 2 rule(s) restored."
      },
      {
        label: "merge, payload carries the default of every setting over a customised device",
        mode: "merge",
        seedSettings: CUSTOM_SETTINGS,
        payload: {
          schema: "advanced-tab-manager",
          version: 2,
          settings: { groupUnmatched: true, groupSortMode: "alphabetical", groupColorMode: "assigned", selectedTabTheme: false },
          groups: [
            { name: "shared", pattern: "*gamma.invalid*", color: "purple" },
            { name: "Delta", pattern: "*delta.invalid*", color: "orange" }
          ]
        },
        groups: '[{"name":"Keep","pattern":"*keep.invalid*","color":"red","createdOrder":4},{"name":"shared","pattern":"*gamma.invalid*","color":"purple","createdOrder":9},{"name":"Delta","pattern":"*delta.invalid*","color":"orange","createdOrder":10}]',
        settings: SEED_SETTINGS,
        list: ["Keep", "shared", "Delta"],
        status: "status success: Import complete. 2 rule(s) imported, 3 rule(s) now configured."
      },
      {
        label: "replace, raw array without settings over a customised device",
        mode: "replace",
        seedSettings: CUSTOM_SETTINGS,
        payload: [{ name: "Solo", pattern: "*solo.invalid*" }],
        groups: '[{"name":"Solo","pattern":"*solo.invalid*","color":"blue","createdOrder":1}]',
        settings: CUSTOM_SETTINGS,
        list: ["Solo"],
        status: "status success: Import complete. 1 rule(s) restored."
      }
    ];
    const expectedOf = c => ({ groups: c.groups, settings: c.settings, controls: c.settings, groupMap: null, list: c.list, status: c.status, applyCalls: 1, groupWrites: [c.groups] });
    const untouchedBut = status => ({ groups: SEED_GROUPS, settings: SEED_SETTINGS, controls: SEED_SETTINGS, groupMap: { stale: 1 }, list: ["Keep", "Shared"], status, applyCalls: 0, groupWrites: [] });

    try {
      await check("import: applyBackupPayload applies a plain payload in merge and replace mode, with no File", async () => {
        const bad = [];
        for (const c of CASES) {
          const { thrown, got } = await drive(() => opt.applyBackupPayload(c.payload, c.mode), c.applyOk !== false, c.seedSettings);
          if (thrown) bad.push({ label: c.label, thrown });
          bad.push(...mismatches(c.label, got, expectedOf(c)));
        }
        return { pass: bad.length === 0, detail: JSON.stringify(bad) };
      });

      await check("import: applyBackupPayload reports a payload it rejects and leaves rules, settings and the page alone", async () => {
        const REJECTED = [
          [{ schema: "other", groups: [] }, "Unsupported backup schema: other"],
          [{ schema: "advanced-tab-manager", version: 99, groups: [] }, "This backup uses version 99. This extension supports up to version 2."],
          [{ groups: "nope" }, 'The backup does not contain a valid "groups" array.'],
          [null, 'The backup does not contain a valid "groups" array.'],
          [[{ name: "Z", pattern: "a" }, { name: "z", pattern: "b" }], 'The import contains more than one rule named "z".']
        ];
        const bad = [];
        for (const [payload, message] of REJECTED) {
          for (const mode of ["replace", "merge"]) {
            const { thrown, got } = await drive(() => opt.applyBackupPayload(payload, mode));
            const label = `${mode}: ${message}`;
            if (thrown) bad.push({ label, thrown });
            bad.push(...mismatches(label, got, untouchedBut(`status error: Import failed: ${message}`)));
          }
        }
        return { pass: bad.length === 0, detail: JSON.stringify(bad) };
      });

      await check("import: importRules hands the mode chosen under Backup & Restore to applyBackupPayload", async () => {
        const bad = [];
        for (const c of CASES) {
          const { thrown, got } = await drive(async () => {
            setMode(c.mode);
            await opt.importRules(new opt.File([JSON.stringify(c.payload)], "payload.json", { type: "application/json" }));
          }, c.applyOk !== false, c.seedSettings);
          if (thrown) bad.push({ label: c.label, thrown });
          bad.push(...mismatches(c.label, got, expectedOf(c)));
        }
        return { pass: bad.length === 0, detail: JSON.stringify(bad) };
      });

      await check("import: importRules reports a file that is too large, unreadable or not JSON and changes nothing", async () => {
        setMode("replace");
        const BAD_FILES = [
          [new opt.File(["x".repeat(1024 * 1024 + 1)], "big.json", { type: "application/json" }), "the selected file is larger than 1 MB."],
          [{ size: 5, text: () => Promise.reject(new Error("disk unreadable")) }, "disk unreadable"],
          [new opt.File(["not json"], "bad.json", { type: "application/json" }), "The selected file is not valid JSON."]
        ];
        const bad = [];
        for (const [file, message] of BAD_FILES) {
          const { thrown, got } = await drive(() => opt.importRules(file));
          if (thrown) bad.push({ label: message, thrown });
          bad.push(...mismatches(message, got, untouchedBut(`status error: Import failed: ${message}`)));
        }
        return { pass: bad.length === 0, detail: JSON.stringify(bad) };
      });
    } finally {
      opt.applyRules = realApplyRules;
      setMode("replace");
      await browser.storage.local.remove([...KEYS, "groupMap"]);
      await setStore(saved);
      await opt.loadSettings();
      await opt.refreshList("groupList");
      opt.clearStatus();
    }
  }

  await check("import: full importRules replace via File", async () => {
    const file = new opt.File([JSON.stringify({ schema: "auto-group-tabs", version: 2, settings: { groupUnmatched: false, groupColorMode: "assigned", groupSortMode: "alphabetical", selectedTabTheme: false }, groups: [{ name: "Only", pattern: "*127.0.0.1*/work*", color: "cyan" }] })], "b.json", { type: "application/json" });
    await opt.importRules(file);
    await settle();
    const st = await browser.storage.local.get(null);
    const s = await snapshot();
    const status = opt.document.getElementById("backupStatus").textContent;
    return { pass: st.groups.length === 1 && st.groupUnmatched === false && groupOf(s, "A/work/1") === "Only(3)" && s.find(t => t.path === "A/work/1").color === "cyan", detail: JSON.stringify({ status, groups: st.groups, s: s.map(({ path, group }) => [path, group]).slice(0, 6) }) };
  });

  // ---------------------------------------------------------------- slot codec
  {
    const ID = "0b9f2c1e-5d3a-4e7b-8c6d-1a2b3c4d5e6f";
    const ITEM_LIMIT = 8192;
    const META_KEY = `atm-backup:${ID}:meta`;
    const AT_FX = "2026-10-01T08:30:00.000Z";
    const SETTINGS = { groupUnmatched: true, groupSortMode: "alphabetical", groupColorMode: "assigned", selectedTabTheme: false };
    const META = { label: "macOS 2026-09-30", createdAt: "2026-09-30T10:00:00.000Z", active: true };
    const R1 = { name: "Work", pattern: "*work*", color: "blue", createdOrder: 1 };
    const R2 = { name: 'Say "Merhaba" ş', pattern: "*ç\\ğ*|*ü*", color: "gray", createdOrder: 2 };
    const R3 = { name: "Docs", pattern: "*docs*", color: "red", createdOrder: 3 };
    // SHA-256 of the hand-written text {"schema":"advanced-tab-manager","version":2,"settings":{...},"groups":[R1,R2,R3]},
    // computed with node:crypto, not with the extension.
    const FX_HASH = "fa060abca047da0c5e95f27383210935e1ef4ec90cad19764d5ea7f344a06b27";
    const FX = {
      "atm-backup:0b9f2c1e-5d3a-4e7b-8c6d-1a2b3c4d5e6f:meta": {
        format: 1,
        label: "macOS 2026-09-30",
        createdAt: "2026-09-30T10:00:00.000Z",
        active: true,
        chunkCount: 2,
        ruleCount: 3,
        hash: FX_HASH,
        schema: "advanced-tab-manager",
        version: 2,
        exportedAt: "2026-10-01T08:30:00.000Z",
        settings: { groupUnmatched: true, groupSortMode: "alphabetical", groupColorMode: "assigned", selectedTabTheme: false }
      },
      "atm-backup:0b9f2c1e-5d3a-4e7b-8c6d-1a2b3c4d5e6f:c0": [
        { name: "Work", pattern: "*work*", color: "blue", createdOrder: 1 },
        { name: 'Say "Merhaba" ş', pattern: "*ç\\ğ*|*ü*", color: "gray", createdOrder: 2 }
      ],
      "atm-backup:0b9f2c1e-5d3a-4e7b-8c6d-1a2b3c4d5e6f:c1": [
        { name: "Docs", pattern: "*docs*", color: "red", createdOrder: 3 }
      ]
    };

    const ID2 = "7a1d4e90-2b3c-4f5a-9d8e-0c1b2a3f4e5d";
    const ID3 = "5e8f0a12-7b6c-4d3e-a1f0-9c8b7a6d5e4f";
    const META_KEY2 = "atm-backup:7a1d4e90-2b3c-4f5a-9d8e-0c1b2a3f4e5d:meta";
    const SETTINGS2 = { groupUnmatched: false, groupSortMode: "creation", groupColorMode: "random", selectedTabTheme: true };
    const R4 = { name: "Yazışma", pattern: "*posta*|*mail*", color: "green", createdOrder: 4 };
    // Shares nothing with FX but the layout, so a slot decoded from another device's keys or settings cannot pass.
    // SHA-256 of the hand-written text {"schema":"advanced-tab-manager","version":2,"settings":{...SETTINGS2...},"groups":[R3,R4]}, computed with node:crypto.
    const FX2_HASH = "dc9aca3ca31d2d4caf09fb62b42904c8336264383510ccc015eea02c659da14a";
    const FX2 = {
      "atm-backup:7a1d4e90-2b3c-4f5a-9d8e-0c1b2a3f4e5d:meta": {
        format: 1,
        label: "Windows 2026-09-29",
        createdAt: "2026-09-29T09:00:00.000Z",
        active: false,
        chunkCount: 1,
        ruleCount: 2,
        hash: FX2_HASH,
        schema: "advanced-tab-manager",
        version: 2,
        exportedAt: "2026-09-30T12:00:00.000Z",
        settings: { groupUnmatched: false, groupSortMode: "creation", groupColorMode: "random", selectedTabTheme: true }
      },
      "atm-backup:7a1d4e90-2b3c-4f5a-9d8e-0c1b2a3f4e5d:c0": [
        { name: "Docs", pattern: "*docs*", color: "red", createdOrder: 3 },
        { name: "Yazışma", pattern: "*posta*|*mail*", color: "green", createdOrder: 4 }
      ]
    };
    // Third device: meta announces two chunks, only c0 arrived.
    const FX3 = {
      "atm-backup:5e8f0a12-7b6c-4d3e-a1f0-9c8b7a6d5e4f:meta": {
        format: 1,
        label: "Linux 2026-09-28",
        createdAt: "2026-09-28T07:00:00.000Z",
        active: true,
        chunkCount: 2,
        ruleCount: 3,
        hash: FX_HASH,
        schema: "advanced-tab-manager",
        version: 2,
        exportedAt: "2026-09-30T13:00:00.000Z",
        settings: { groupUnmatched: true, groupSortMode: "alphabetical", groupColorMode: "assigned", selectedTabTheme: false }
      },
      "atm-backup:5e8f0a12-7b6c-4d3e-a1f0-9c8b7a6d5e4f:c0": [
        { name: "Work", pattern: "*work*", color: "blue", createdOrder: 1 },
        { name: 'Say "Merhaba" ş', pattern: "*ç\\ğ*|*ü*", color: "gray", createdOrder: 2 }
      ]
    };

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const bytes = text => new TextEncoder().encode(text).length;
    const itemBytes = (key, value) => bytes(key) + bytes(JSON.stringify(value));
    const chunkKey = (id, i) => `atm-backup:${id}:c${i}`;
    const without = (items, drop) => Object.fromEntries(Object.entries(items).filter(([key]) => key !== drop));
    const backupOf = (groups, extra = {}) => ({ schema: "advanced-tab-manager", version: 2, exportedAt: AT_FX, settings: SETTINGS, groups, ...extra });
    const encode = (groups, extra) => bg.encodeSlot(ID, backupOf(groups, extra), META);
    const nasty = n => Array.from({ length: n }, (_, i) => ({
      name: `Çalışma ${i} "ğüşiöç" \\ İI${i % 7 === 0 ? " 😀" : ""}`,
      pattern: `*example${i}.com/ç"ş\\*|*ığ${i}.org/*`,
      color: "blue",
      createdOrder: i + 1
    }));
    const ruleOfSize = total => {
      const base = bytes(JSON.stringify({ name: "", pattern: "*p*", color: "blue", createdOrder: 1 }));
      return { name: "n".repeat(total - base), pattern: "*p*", color: "blue", createdOrder: 1 };
    };
    const padded = (key, size) => "x".repeat(size - bytes(key) - 2);
    const accepted = async items => {
      try {
        await browser.storage.sync.set(items);
        return { ok: true };
      } catch (e) {
        return { ok: false, quota: /QuotaExceededError/.test(String(e.message || e)) };
      }
    };

    await check("backup: contentHash is the node-computed SHA-256 of the hand-written text and ignores exportedAt", async () => {
      const backup = backupOf([R1, R2, R3]);
      const got = await bg.contentHash(backup);
      const later = await bg.contentHash({ ...backup, exportedAt: "2027-01-01T00:00:00.000Z" });
      const otherPattern = await bg.contentHash({ ...backup, groups: [{ ...R1, pattern: "*work2*" }, R2, R3] });
      const otherSettings = await bg.contentHash({ ...backup, settings: { ...SETTINGS, groupUnmatched: false } });
      return { pass: got === FX_HASH && later === got && otherPattern !== got && otherSettings !== got, detail: JSON.stringify({ got, later, otherPattern, otherSettings }) };
    });

    await check("backup: encodeSlot writes exactly the hand-written raw layout", async () => {
      const saved = bg.SYNC_BACKUP_CHUNK_BUDGET_BYTES;
      bg.SYNC_BACKUP_CHUNK_BUDGET_BYTES = itemBytes(chunkKey(ID, 0), [R1, R2]) + 5;
      let slot;
      try {
        slot = await encode([R1, R2, R3]);
      } finally {
        bg.SYNC_BACKUP_CHUNK_BUDGET_BYTES = saved;
      }
      const mismatched = Object.keys(FX).filter(key => !same(slot.items[key], FX[key]));
      return {
        pass: mismatched.length === 0 && same([...slot.keys].sort(), Object.keys(FX).sort()) && same(Object.keys(slot.items).sort(), Object.keys(FX).sort()),
        detail: JSON.stringify({ mismatched, keys: slot.keys, items: slot.items })
      };
    });

    await check("backup: encodeSlot takes label, createdAt, active, settings and exportedAt and the device id from its own arguments", async () => {
      const backup = backupOf([R1], { exportedAt: "2027-02-03T04:05:06.000Z", settings: SETTINGS2 });
      const stopped = { label: "Linux 2026-08-01", createdAt: "2026-08-01T00:00:00.000Z", active: false };
      const slot = await bg.encodeSlot(ID2, backup, stopped);
      const item = slot.items[META_KEY2];
      const wanted = {
        label: "Linux 2026-08-01",
        createdAt: "2026-08-01T00:00:00.000Z",
        active: false,
        exportedAt: "2027-02-03T04:05:06.000Z",
        settings: { groupUnmatched: false, groupSortMode: "creation", groupColorMode: "random", selectedTabTheme: true }
      };
      const wrong = Object.keys(wanted).filter(field => !same(item?.[field], wanted[field]));
      const [listed] = await opt.listSlots(slot.items);
      const keys = [...slot.keys].sort();
      const wantedKeys = ["atm-backup:7a1d4e90-2b3c-4f5a-9d8e-0c1b2a3f4e5d:c0", "atm-backup:7a1d4e90-2b3c-4f5a-9d8e-0c1b2a3f4e5d:meta"];
      return {
        pass: wrong.length === 0 && same(keys, wantedKeys) && listed.deviceId === ID2 && listed.status === "complete" && listed.meta.active === false && same(listed.backup, backup),
        detail: JSON.stringify({ wrong, keys, item, status: listed.status, deviceId: listed.deviceId, active: listed.meta?.active })
      };
    });

    await check("backup: listSlots decodes the hand-written raw slot as complete", async () => {
      const slots = await opt.listSlots(FX);
      const expected = { schema: "advanced-tab-manager", version: 2, exportedAt: "2026-10-01T08:30:00.000Z", settings: SETTINGS, groups: [R1, R2, R3] };
      const [slot] = slots;
      return {
        pass: slots.length === 1 && slot.deviceId === ID && slot.status === "complete" && same(slot.backup, expected) && same(slot.meta, FX[META_KEY]),
        detail: JSON.stringify(slots)
      };
    });

    await check("backup: listSlots lists every device and decodes each one from its own keys", async () => {
      const slots = await opt.listSlots({ ...FX3, ...FX, ...FX2 });
      const byId = Object.fromEntries(slots.map(s => [s.deviceId, s]));
      const first = byId[ID];
      const second = byId[ID2];
      const broken = byId[ID3];
      const expectedFirst = { schema: "advanced-tab-manager", version: 2, exportedAt: "2026-10-01T08:30:00.000Z", settings: SETTINGS, groups: [R1, R2, R3] };
      const expectedSecond = { schema: "advanced-tab-manager", version: 2, exportedAt: "2026-09-30T12:00:00.000Z", settings: SETTINGS2, groups: [R3, R4] };
      return {
        pass:
          slots.length === 3 &&
          same(Object.keys(byId).sort(), [ID, ID2, ID3].sort()) &&
          first?.status === "complete" && same(first.backup, expectedFirst) && same(first.meta, FX[META_KEY]) &&
          second?.status === "complete" && same(second.backup, expectedSecond) && same(second.meta, FX2[META_KEY2]) &&
          broken?.status === "incomplete" && broken.backup === null,
        detail: JSON.stringify(slots.map(s => ({ deviceId: s.deviceId, status: s.status, label: s.meta?.label, active: s.meta?.active, groups: s.backup?.groups?.map(r => r.name) })))
      };
    });

    await check("backup: encodeSlot items fit the per-item limit of real storage.sync", async () => {
      const slot = await encode(nasty(300));
      const sizes = slot.keys.map(key => [key, itemBytes(key, slot.items[key])]);
      const over = sizes.filter(([, size]) => size > ITEM_LIMIT);
      const chunks = slot.keys.filter(key => key !== META_KEY);
      const placed = chunks.reduce((n, key) => n + slot.items[key].length, 0);
      return {
        pass: over.length === 0 && chunks.length >= 5 && placed === 300 && same([...slot.keys].sort(), Object.keys(slot.items).sort()),
        detail: JSON.stringify({ over, chunks: chunks.length, placed, sizes: sizes.map(([, n]) => n) })
      };
    });

    await check("backup: encodeSlot fills a chunk up to the budget and no further", async () => {
      const budget = bg.SYNC_BACKUP_CHUNK_BUDGET_BYTES;
      const third = budget - bytes(chunkKey(ID, 0)) - 2 - 100 - 100 - 2;
      const layout = async thirdSize => {
        const slot = await encode([ruleOfSize(100), ruleOfSize(100), ruleOfSize(thirdSize), ruleOfSize(100)]);
        const chunks = slot.keys.filter(key => key !== META_KEY);
        return { counts: chunks.map(key => slot.items[key].length), first: itemBytes(chunkKey(ID, 0), slot.items[chunkKey(ID, 0)]) };
      };
      const exact = await layout(third);
      const over = await layout(third + 1);
      return { pass: same(exact.counts, [3, 1]) && exact.first === budget && same(over.counts, [2, 2]), detail: JSON.stringify({ budget, exact, over }) };
    });

    await check("backup: encodeSlot throws 'too large' for a rule that cannot fit one item and accepts one that just fits", async () => {
      const alone = bg.SYNC_BACKUP_CHUNK_BUDGET_BYTES - bytes(chunkKey(ID, 0)) - 2;
      const attempt = async groups => {
        try {
          const slot = await encode(groups);
          return { chunks: slot.keys.length - 1 };
        } catch (e) {
          return { error: e.message };
        }
      };
      const got = {
        fits: await attempt([ruleOfSize(alone)]),
        big: await attempt([ruleOfSize(alone + 1)]),
        second: await attempt([ruleOfSize(100), ruleOfSize(alone + 1)]),
        first: await attempt([ruleOfSize(alone + 1), ruleOfSize(100)])
      };
      const tooLarge = (r, n) => !!r.error && r.error.includes("too large") && r.error.includes(`Rule ${n} `);
      return { pass: got.fits.chunks === 1 && tooLarge(got.big, 1) && tooLarge(got.second, 2) && tooLarge(got.first, 1), detail: JSON.stringify(got) };
    });

    await check("backup: a multi-chunk slot of non-ASCII, quote and backslash rules survives real storage.sync", async () => {
      const backup = backupOf(nasty(300));
      const slot = await bg.encodeSlot(ID, backup, META);
      let slots;
      try {
        await browser.storage.sync.set(slot.items);
        slots = await opt.listSlots(await browser.storage.sync.get(null));
      } finally {
        await browser.storage.sync.remove(slot.keys);
      }
      const left = Object.keys(await browser.storage.sync.get(null));
      return {
        pass: slots.length === 1 && slots[0].status === "complete" && same(slots[0].backup, backup) && slots[0].meta.chunkCount >= 5 && left.length === 0,
        detail: JSON.stringify({ statuses: slots.map(s => s.status), chunkCount: slots[0]?.meta?.chunkCount, left })
      };
    });

    await check("backup: listSlots reports incomplete for a missing, swapped, edited or non-array chunk and a missing meta", async () => {
      const a = await encode(nasty(200));
      const b = await encode(nasty(200).map(r => ({ ...r, pattern: r.pattern + "z" })));
      const last = a.keys.length - 2;
      const edited = JSON.parse(JSON.stringify(a.items[chunkKey(ID, 2)]));
      edited[0].pattern = edited[0].pattern.replace("example", "exampl3");
      const cases = [
        ["intact", a.items, "complete"],
        ["chunk 1 missing", without(a.items, chunkKey(ID, 1)), "incomplete"],
        ["last chunk missing", without(a.items, chunkKey(ID, last)), "incomplete"],
        ["chunk 1 from another encoding", { ...a.items, [chunkKey(ID, 1)]: b.items[chunkKey(ID, 1)] }, "incomplete"],
        ["chunk 2 edited", { ...a.items, [chunkKey(ID, 2)]: edited }, "incomplete"],
        ["chunk 1 not an array", { ...a.items, [chunkKey(ID, 1)]: { not: "an array" } }, "incomplete"],
        ["meta missing", without(a.items, META_KEY), "incomplete"]
      ];
      const got = [];
      for (const [name, items, status] of cases) {
        const [slot] = await opt.listSlots(items);
        got.push({ name, status: slot.status, want: status, backupNull: slot.backup === null });
      }
      const bad = got.filter(c => c.status !== c.want || (c.want !== "complete" && !c.backupNull));
      const premises = a.keys.length >= 5 && b.keys.length === a.keys.length && !same(a.items[chunkKey(ID, 1)], b.items[chunkKey(ID, 1)]);
      return { pass: premises && bad.length === 0, detail: JSON.stringify({ premises, bad, got }) };
    });

    await check("backup: listSlots ignores chunks past chunkCount left behind by a longer older slot", async () => {
      const longer = await encode(nasty(200));
      const shorterBackup = backupOf(nasty(60));
      const shorter = await bg.encodeSlot(ID, shorterBackup, META);
      const stale = Object.fromEntries(longer.keys.filter(key => !shorter.keys.includes(key)).map(key => [key, longer.items[key]]));
      const [slot] = await opt.listSlots({ ...shorter.items, ...stale });
      return {
        pass: Object.keys(stale).length >= 2 && slot.status === "complete" && same(slot.backup, shorterBackup),
        detail: JSON.stringify({ stale: Object.keys(stale), status: slot.status })
      };
    });

    await check("backup: listSlots reports unknown-format for a meta with another layout format", async () => {
      const base = await encode([R1, R2, R3]);
      const cases = [[1, "complete"], [2, "unknown-format"], ["1", "unknown-format"], [0, "unknown-format"], [undefined, "unknown-format"]];
      const got = [];
      for (const [format, want] of cases) {
        const [slot] = await opt.listSlots({ ...base.items, [META_KEY]: { ...base.items[META_KEY], format } });
        got.push({ format: String(format), status: slot.status, want, backupNull: slot.backup === null });
      }
      const bad = got.filter(c => c.status !== c.want || (c.want !== "complete" && !c.backupNull));
      return { pass: bad.length === 0, detail: JSON.stringify({ bad, got }) };
    });

    await check("backup: listSlots reports unknown-format for a backup newer than this extension understands", async () => {
      const cases = [[2, "complete"], [3, "unknown-format"], [99, "unknown-format"]];
      const got = [];
      for (const [version, want] of cases) {
        const slot = await encode([R1, R2, R3], { version });
        const [listed] = await opt.listSlots(slot.items);
        got.push({ version, status: listed.status, want, backupNull: listed.backup === null });
      }
      const bad = got.filter(c => c.status !== c.want || (c.want !== "complete" && !c.backupNull));
      return { pass: bad.length === 0, detail: JSON.stringify({ bad, got }) };
    });

    await check("backup: listSlots reports unknown-format when the intact payload is one parseBackupPayload rejects", async () => {
      const cases = [
        ["valid payload", backupOf([R1, R2, R3]), "complete"],
        ["another schema", backupOf([R1], { schema: "other-app" }), "unknown-format"],
        ["rule without a pattern", backupOf([R1, { name: "Broken", color: "blue" }]), "unknown-format"],
        ["duplicate names", backupOf([R1, { ...R3, name: "work" }]), "unknown-format"]
      ];
      const got = [];
      for (const [name, backup, want] of cases) {
        const slot = await bg.encodeSlot(ID, backup, META);
        const [listed] = await opt.listSlots(slot.items);
        got.push({ name, status: listed.status, want, backupNull: listed.backup === null });
      }
      const bad = got.filter(c => c.status !== c.want || (c.want !== "complete" && !c.backupNull));
      return { pass: bad.length === 0, detail: JSON.stringify({ bad, got }) };
    });

    await check("backup: listSlots ignores keys outside the prefix", async () => {
      const foreign = {
        groups: [R1],
        "btm-backup:dev9:meta": FX[META_KEY],
        "atm-backupx:dev9:meta": FX[META_KEY],
        "backup:atm-backup:dev9:meta": FX[META_KEY]
      };
      const slots = await opt.listSlots({ ...foreign, ...FX });
      return { pass: slots.length === 1 && slots[0].deviceId === ID, detail: JSON.stringify(slots.map(s => s.deviceId)) };
    });

    await check("backup: listSlots lists only devices that slotKeys can find, and nothing for keys without a device id", async () => {
      const items = { ...FX, "atm-backup:nocolon": 1, "atm-backup::x": [] };
      const slots = await opt.listSlots(items);
      const lone = slots.map(s => [s.deviceId, opt.slotKeys(items, s.deviceId).length]);
      return { pass: slots.length === 1 && slots[0].deviceId === ID && lone.every(([, n]) => n > 0), detail: JSON.stringify(lone) };
    });

    await check("backup: slotKeys returns exactly one device's keys, however stray", async () => {
      const items = {
        "atm-backup:dev1:meta": {},
        "atm-backup:dev1:c0": [],
        "atm-backup:dev1:c7": [],
        "atm-backup:dev1:zzz": 1,
        "atm-backup:dev10:meta": {},
        "atm-backup:dev10:c0": [],
        "atm-backup:dev2:meta": {},
        "atm-backup:dev1": 1,
        "btm-backup:dev1:meta": {},
        groups: []
      };
      const got = {
        dev1: [...bg.slotKeys(items, "dev1")].sort(),
        dev10: [...bg.slotKeys(items, "dev10")].sort(),
        nobody: [...bg.slotKeys(items, "dev3")]
      };
      const want = {
        dev1: ["atm-backup:dev1:c0", "atm-backup:dev1:c7", "atm-backup:dev1:meta", "atm-backup:dev1:zzz"],
        dev10: ["atm-backup:dev10:c0", "atm-backup:dev10:meta"],
        nobody: []
      };
      return { pass: same(got, want), detail: JSON.stringify(got) };
    });

    await check("backup: a slot without rules has no chunk and decodes complete", async () => {
      const backup = backupOf([]);
      const slot = await bg.encodeSlot(ID, backup, META);
      const [listed] = await opt.listSlots(slot.items);
      const metaItem = slot.items[META_KEY];
      return {
        pass: same(slot.keys, [META_KEY]) && metaItem.chunkCount === 0 && metaItem.ruleCount === 0 && listed.status === "complete" && same(listed.backup, backup),
        detail: JSON.stringify({ keys: slot.keys, meta: metaItem, status: listed.status })
      };
    });

    await check("backup: SYNC_QUOTA_BYTES_PER_ITEM is the per-item limit of real storage.sync", async () => {
      const keys = ["limit-probe:a", "limit-probe:b"];
      let at, over;
      try {
        at = await accepted({ [keys[0]]: padded(keys[0], ITEM_LIMIT) });
        over = await accepted({ [keys[1]]: padded(keys[1], ITEM_LIMIT + 1) });
      } finally {
        await browser.storage.sync.remove(keys);
      }
      const constant = bg.SYNC_QUOTA_BYTES_PER_ITEM;
      return { pass: at.ok && !over.ok && over.quota && constant === ITEM_LIMIT, detail: JSON.stringify({ at, over, constant }) };
    });

    await check("backup: SYNC_QUOTA_BYTES is the total limit of real storage.sync", async () => {
      const TOTAL_LIMIT = 102400;
      const keys = Array.from({ length: 13 }, (_, i) => `limit-probe:t${String(i).padStart(2, "0")}`);
      const lastAtLimit = TOTAL_LIMIT - 1 - 4 * keys.length - 12 * ITEM_LIMIT;
      const items = lastSize => Object.fromEntries(keys.map((key, i) => [key, padded(key, i < 12 ? ITEM_LIMIT : lastSize)]));
      let at, over;
      try {
        at = await accepted(items(lastAtLimit));
        over = await accepted({ [keys[12]]: padded(keys[12], lastAtLimit + 1) });
      } finally {
        await browser.storage.sync.remove(keys);
      }
      const constant = bg.SYNC_QUOTA_BYTES;
      return { pass: at.ok && !over.ok && over.quota && constant === TOTAL_LIMIT, detail: JSON.stringify({ at, over, constant }) };
    });

    await check("backup: SYNC_MAX_ITEMS is the item-count limit of real storage.sync", async () => {
      const MAX_ITEMS = 512;
      const keys = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `limit-probe:m${i}`);
      let at, over;
      try {
        at = await accepted(Object.fromEntries(keys.slice(0, MAX_ITEMS).map(key => [key, 1])));
        over = await accepted({ [keys[MAX_ITEMS]]: 1 });
      } finally {
        await browser.storage.sync.remove(keys);
      }
      const constant = bg.SYNC_MAX_ITEMS;
      return { pass: at.ok && !over.ok && over.quota && constant === MAX_ITEMS, detail: JSON.stringify({ at, over, constant }) };
    });

    await check("backup: the slot codec checks leave browser.storage.sync empty", async () => {
      const left = Object.keys(await browser.storage.sync.get(null));
      return { pass: left.length === 0, detail: JSON.stringify(left) };
    });
  }

  // ---------------------------------------------------------------- sync backup writer
  {
    const DEBOUNCE = 400;
    const PREFIX = "atm-backup:";
    const TOTAL_LIMIT = 102400;
    const OS_NAMES = { mac: "macOS", win: "Windows", linux: "Linux", android: "Android" };
    const S0 = { groupUnmatched: true, groupSortMode: "alphabetical", groupColorMode: "assigned", selectedTabTheme: false };
    const rule = (i, extra = {}) => ({ name: `Rule ${i}`, pattern: `*rule${i}.example*`, color: "blue", createdOrder: i, ...extra });
    const rules = n => Array.from({ length: n }, (_, i) => rule(i + 1));
    const broken = [rule(1), { name: "Broken", pattern: "", color: "red", createdOrder: 2 }];
    const canon = value => JSON.stringify(value, (key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
    const same = (a, b) => canon(a) === canon(b);
    const bytes = text => new TextEncoder().encode(text).length;
    // Timers of this page fire about one second late, which breaks the sub-second debounce spacing below; the background page's timers do not.
    const sleep = ms => new Promise(resolve => bg.setTimeout(resolve, ms));
    const until = async (fn, ms = 6000) => {
      const end = Date.now() + ms;
      for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > end) return null;
        await sleep(60);
      }
    };
    const syncAll = () => browser.storage.sync.get(null);
    const slotItems = async () => Object.fromEntries(Object.entries(await syncAll()).filter(([key]) => key.startsWith(PREFIX)));
    const deviceId = async () => (await browser.storage.local.get("syncBackupDeviceId")).syncBackupDeviceId ?? null;
    const status = async () => (await browser.storage.local.get("syncBackupStatus")).syncBackupStatus ?? null;
    const liveGroups = async () => (await browser.storage.local.get("groups")).groups;
    const slotOf = async () => {
      const id = await deviceId();
      if (!id) return null;
      return (await bg.listSlots(await syncAll())).find(s => s.deviceId === id) ?? null;
    };
    const waitSlot = test => until(async () => {
      const slot = await slotOf();
      return slot && test(slot) ? slot : null;
    });
    const complete = (groups, settings = S0) => slot => slot.status === "complete" && same(slot.backup.groups, groups) && same(slot.backup.settings, settings);
    const idle = async () => {
      await sleep(100);
      let calm = 0;
      const ok = await until(async () => {
        calm = !bg.syncBackupTimer && !bg.syncBackupRunning ? calm + 1 : 0;
        return calm >= 2;
      }, 8000);
      return Boolean(ok);
    };
    const watchSync = () => {
      const events = [];
      const listener = (changes, area) => {
        if (area === "sync") events.push(Object.keys(changes));
      };
      browser.storage.onChanged.addListener(listener);
      return { events, done: () => browser.storage.onChanged.removeListener(listener) };
    };
    const clearSync = async () => {
      const keys = Object.keys(await syncAll()).filter(key => key.startsWith(PREFIX) || key.startsWith("filler:"));
      if (keys.length > 0) await browser.storage.sync.remove(keys);
    };
    const start = async ({ state = {}, drop = [], arm } = {}) => {
      await idle();
      await clearSync();
      await browser.storage.local.remove(["syncBackupDeviceId", "syncBackupStatus"]);
      await setStore({ syncBackupEnabled: false, groups: rules(2), ...S0, ...state });
      if (drop.length > 0) await browser.storage.local.remove(drop);
      await idle();
      if (arm) await arm();
      await setStore({ syncBackupEnabled: true });
    };
    const stop = async () => {
      await setStore({ syncBackupEnabled: false });
      await idle();
      await clearSync();
      await browser.storage.local.remove(["syncBackupDeviceId", "syncBackupStatus"]);
    };
    const scenario = async (options, fn) => {
      await start(options);
      try {
        return await fn();
      } finally {
        await stop();
      }
    };
    const overQuota = async big => {
      const used = Object.entries(await syncAll()).reduce((sum, [key, value]) => sum + bytes(key) + bytes(JSON.stringify(value)) + 4, 1);
      const filler = {};
      let remaining = TOTAL_LIMIT - 1500 - used;
      for (let i = 0; remaining > 40; i++) {
        const key = `filler:${i}`;
        const size = Math.min(8192, remaining - 4);
        filler[key] = "x".repeat(size - bytes(key) - 2);
        remaining -= size + 4;
      }
      await browser.storage.sync.set(filler);
      await setStore({ groups: big });
      return until(async () => (await status())?.error);
    };

    const knob = bg.SYNC_BACKUP_DEBOUNCE_MS;
    const saved = await browser.storage.local.get(null);
    try {
      await check("sync backup: the writer is loaded in the background page", async () => {
        const seen = { run: typeof bg.runSyncBackup, knob: typeof knob };
        return { pass: seen.run === "function" && seen.knob === "number", detail: JSON.stringify(seen) };
      });
      bg.SYNC_BACKUP_DEBOUNCE_MS = DEBOUNCE;

      await check("sync backup: with the toggle never set, rule changes write nothing to Firefox Sync and create no device id", async () => {
        await idle();
        await clearSync();
        await browser.storage.local.remove(["syncBackupEnabled", "syncBackupDeviceId", "syncBackupStatus"]);
        const watch = watchSync();
        try {
          await setStore({ groups: rules(3) });
          await sleep(DEBOUNCE * 2 + 200);
          await idle();
          const keys = Object.keys(await slotItems());
          const id = await deviceId();
          return { pass: keys.length === 0 && watch.events.length === 0 && id === null, detail: JSON.stringify({ keys, events: watch.events, id }) };
        } finally {
          watch.done();
          await stop();
        }
      });

      await check("sync backup: a fresh install with no rules and no settings stored writes an empty slot with the default settings", async () => {
        const drop = ["groups", "groupUnmatched", "groupSortMode", "groupColorMode", "selectedTabTheme"];
        return scenario({ drop }, async () => {
          const slot = await waitSlot(complete([], S0));
          return { pass: Boolean(slot), detail: JSON.stringify({ slot: slot && { status: slot.status, backup: slot.backup }, written: await status() }) };
        });
      });

      await check("sync backup: toggle on writes the slot, and a change to any source key rewrites it", async () => {
        const all = { ...S0, groupUnmatched: false, groupSortMode: "creation", groupColorMode: "random" };
        const steps = [
          [{}, rules(1), S0],
          [{ groups: rules(3) }, rules(3), S0],
          [{ groups: rules(2) }, rules(2), S0],
          [{ groupUnmatched: false }, rules(2), { ...S0, groupUnmatched: false }],
          [{ groupSortMode: "creation" }, rules(2), { ...S0, groupUnmatched: false, groupSortMode: "creation" }],
          [{ groupColorMode: "random" }, rules(2), all],
          [{ selectedTabTheme: true }, rules(2), { ...all, selectedTabTheme: true }]
        ];
        return scenario({ state: { groups: rules(1) } }, async () => {
          const seen = [];
          for (const [change, groups, settings] of steps) {
            if (Object.keys(change).length > 0) await setStore(change);
            const slot = await waitSlot(complete(groups, settings));
            seen.push(slot ? "ok" : "missing " + JSON.stringify(Object.keys(change)) + " " + JSON.stringify(await slotOf()));
            if (!slot) break;
          }
          return { pass: seen.length === steps.length && seen.every(s => s === "ok"), detail: JSON.stringify(seen) };
        });
      });

      await check("sync backup: the label is the OS name and the creation date", async () => {
        const before = new Date().toISOString();
        return scenario({}, async () => {
          const slot = await waitSlot(s => s.status === "complete");
          const { os } = await browser.runtime.getPlatformInfo();
          const after = new Date().toISOString();
          const meta = slot?.meta;
          const label = `${OS_NAMES[os] ?? os} ${meta?.createdAt?.slice(0, 10)}`;
          const pass = Boolean(slot) && meta.label === label && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(meta.createdAt) && meta.createdAt >= before && meta.createdAt <= after;
          return { pass, detail: JSON.stringify({ meta, label, before, after }) };
        });
      });

      await check("sync backup: a later write keeps the label and creation date of the slot", async () => {
        return scenario({}, async () => {
          const first = await waitSlot(s => s.status === "complete");
          await idle();
          const metaKey = `${PREFIX}${first.deviceId}:meta`;
          await browser.storage.sync.set({ [metaKey]: { ...first.meta, label: "Kept label", createdAt: "2020-01-01T00:00:00.000Z" } });
          await setStore({ groups: rules(3) });
          const next = await waitSlot(complete(rules(3)));
          return { pass: Boolean(next) && next.meta.label === "Kept label" && next.meta.createdAt === "2020-01-01T00:00:00.000Z", detail: JSON.stringify(next?.meta) };
        });
      });

      await check("sync backup: the slot equals the exported file for rules without createdOrder and a state without settings keys", async () => {
        const legacy = [{ name: "Old A", pattern: "*a.example*", color: "green" }, { name: "Old B", pattern: "*b.example*", color: "red" }];
        const wanted = [{ ...legacy[0], createdOrder: 1 }, { ...legacy[1], createdOrder: 2 }];
        const drop = ["groupUnmatched", "groupSortMode", "groupColorMode", "selectedTabTheme"];
        return scenario({ state: { groups: legacy }, drop }, async () => {
          const slot = await waitSlot(complete(wanted, S0));
          const exported = JSON.parse(await captureExport(opt));
          const written = { ...slot?.backup };
          delete exported.exportedAt;
          delete written.exportedAt;
          return {
            pass: Boolean(slot) && same(exported.groups, wanted) && same(written, exported),
            detail: JSON.stringify({ written, exported })
          };
        });
      });

      await check("sync backup: changes outside the source keys cause no slot write, a source change does", async () => {
        return scenario({}, async () => {
          const first = await waitSlot(s => s.status === "complete");
          await idle();
          const metaKey = `${PREFIX}${first.deviceId}:meta`;
          await browser.storage.sync.set({ [metaKey]: { ...first.meta, hash: "tampered" } });
          const watch = watchSync();
          try {
            await setStore({ groupMap: { 1: "x" } });
            await sleep(DEBOUNCE * 2 + 200);
            await setStore({ syncBackupStatus: { lastWrittenAt: null, error: null } });
            await sleep(DEBOUNCE * 2 + 200);
            await setStore({ syncBackupDeviceId: first.deviceId, unrelated: 1 });
            await sleep(DEBOUNCE * 2 + 200);
            const quiet = watch.events.length;
            await setStore({ groups: rules(3) });
            const wrote = await until(() => watch.events.some(keys => keys.includes(metaKey)));
            return { pass: quiet === 0 && Boolean(wrote), detail: JSON.stringify({ quiet, events: watch.events }) };
          } finally {
            watch.done();
          }
        });
      });

      await check("sync backup: rapid changes inside one debounce window cause one write", async () => {
        return scenario({}, async () => {
          const first = await waitSlot(s => s.status === "complete");
          await idle();
          const metaKey = `${PREFIX}${first.deviceId}:meta`;
          const watch = watchSync();
          try {
            for (const n of [3, 4, 5, 6]) {
              await setStore({ groups: rules(n) });
              await sleep(DEBOUNCE / 2);
            }
            const last = await waitSlot(complete(rules(6)));
            await idle();
            const writes = watch.events.filter(keys => keys.includes(metaKey)).length;
            return { pass: Boolean(last) && writes === 1, detail: JSON.stringify({ writes, events: watch.events }) };
          } finally {
            watch.done();
          }
        });
      });

      await check("sync backup: overlapping triggers produce one device id and a coherent slot", async () => {
        const realGet = bg.browser.storage.local.get;
        const arm = async () => {
          bg.browser.storage.local.get = async function (...args) {
            const result = await realGet.apply(bg.browser.storage.local, args);
            await sleep(400);
            return result;
          };
          bg.SYNC_BACKUP_DEBOUNCE_MS = 60;
        };
        try {
          return await scenario({ arm }, async () => {
            try {
              await sleep(200);
              await setStore({ groups: rules(3) });
              await idle();
            } finally {
              bg.browser.storage.local.get = realGet;
              bg.SYNC_BACKUP_DEBOUNCE_MS = DEBOUNCE;
            }
            const ids = [...new Set(Object.keys(await syncAll()).filter(key => key.startsWith(PREFIX)).map(key => key.slice(PREFIX.length, key.indexOf(":", PREFIX.length))))];
            const slot = await slotOf();
            return { pass: ids.length === 1 && ids[0] === (await deviceId()) && Boolean(slot) && complete(rules(3))(slot), detail: JSON.stringify({ ids, local: await deviceId(), slot: slot && { status: slot.status, groups: slot.backup?.groups.length } }) };
          });
        } finally {
          bg.browser.storage.local.get = realGet;
          bg.SYNC_BACKUP_DEBOUNCE_MS = DEBOUNCE;
        }
      });

      await check("sync backup: a slot that shrinks leaves no extra chunk keys", async () => {
        const savedBudget = bg.SYNC_BACKUP_CHUNK_BUDGET_BYTES;
        bg.SYNC_BACKUP_CHUNK_BUDGET_BYTES = bytes(`${PREFIX}${"0".repeat(36)}:c0`) + bytes(JSON.stringify(rules(2))) + 10;
        try {
          return await scenario({ state: { groups: rules(6) } }, async () => {
            const keysOf = async id => Object.keys(await syncAll()).filter(key => key.startsWith(`${PREFIX}${id}:`)).sort();
            const wide = await waitSlot(complete(rules(6)));
            await idle();
            const id = wide?.deviceId;
            const before = wide ? await keysOf(id) : [];
            await setStore({ groups: rules(1) });
            const narrow = await waitSlot(complete(rules(1)));
            await idle();
            const after = narrow ? await keysOf(id) : [];
            const wantBefore = ["c0", "c1", "c2", "meta"].map(part => `${PREFIX}${id}:${part}`);
            const wantAfter = ["c0", "meta"].map(part => `${PREFIX}${id}:${part}`);
            return { pass: Boolean(wide) && Boolean(narrow) && same(before, wantBefore) && same(after, wantAfter) && narrow.meta.chunkCount === 1, detail: JSON.stringify({ before, after }) };
          });
        } finally {
          bg.SYNC_BACKUP_CHUNK_BUDGET_BYTES = savedBudget;
        }
      });

      await check("sync backup: toggle off marks the slot stopped and later changes leave it alone, toggle on rewrites it", async () => {
        return scenario({}, async () => {
          const live = await waitSlot(s => s.status === "complete" && s.meta.active === true);
          await idle();
          const metaKey = `${PREFIX}${live?.deviceId}:meta`;
          const chunksOf = items => Object.fromEntries(Object.entries(items).filter(([key]) => key !== metaKey));
          const before = await slotItems();
          await setStore({ syncBackupEnabled: false });
          const stopped = await waitSlot(s => s.meta.active === false);
          await idle();
          const watch = watchSync();
          let during;
          let writes;
          try {
            await setStore({ groups: rules(3) });
            await sleep(DEBOUNCE * 2 + 200);
            during = await slotItems();
            writes = watch.events.length;
          } finally {
            watch.done();
          }
          const untouched = writes === 0 && same(chunksOf(before), chunksOf(during)) && same({ ...before[metaKey], active: false }, during[metaKey]);
          await setStore({ syncBackupEnabled: true });
          const again = await waitSlot(complete(rules(3)));
          return {
            pass: Boolean(live) && Boolean(stopped) && untouched && Boolean(again) && again.meta.active === true,
            detail: JSON.stringify({ live: Boolean(live), stopped: Boolean(stopped), untouched, writes, again: again?.meta })
          };
        });
      });

      await check("sync backup: turning the toggle off with no slot in Firefox Sync writes nothing", async () => {
        return scenario({}, async () => {
          const live = await waitSlot(complete(rules(2)));
          await idle();
          await browser.storage.sync.remove(Object.keys(await slotItems()));
          await sleep(200);
          const watch = watchSync();
          try {
            await setStore({ syncBackupEnabled: false });
            await sleep(DEBOUNCE * 2 + 200);
            await idle();
            const keys = Object.keys(await slotItems());
            return { pass: Boolean(live) && keys.length === 0 && watch.events.length === 0, detail: JSON.stringify({ live: Boolean(live), keys, events: watch.events }) };
          } finally {
            watch.done();
          }
        });
      });

      await check("sync backup: toggle on again with unchanged rules makes the stopped slot active", async () => {
        return scenario({}, async () => {
          const live = await waitSlot(complete(rules(2)));
          await idle();
          await setStore({ syncBackupEnabled: false });
          const stopped = await waitSlot(s => s.meta.active === false);
          await idle();
          await setStore({ syncBackupEnabled: true });
          const again = await waitSlot(s => s.meta.active === true && s.status === "complete");
          return {
            pass: Boolean(live) && Boolean(stopped) && Boolean(again) && again.meta.hash === live.meta.hash && again.meta.label === live.meta.label && again.meta.createdAt === live.meta.createdAt,
            detail: JSON.stringify({ live: live?.meta, again: again?.meta })
          };
        });
      });

      const big = Array.from({ length: 8 }, (_, i) => rule(i + 1, { name: `Big ${i} ${"n".repeat(400)}` }));

      await check("sync backup: a rejected write is recorded, live rules and the previous slot stay as they were", async () => {
        return scenario({}, async () => {
          await waitSlot(complete(rules(2)));
          await idle();
          const before = await slotItems();
          const error = await overQuota(big);
          await idle();
          const after = await slotItems();
          const slot = await slotOf();
          const written = await status();
          return {
            pass: /quota/i.test(error ?? "") && same(await liveGroups(), big) && same(before, after) && Boolean(slot) && complete(rules(2))(slot) && typeof written.lastWrittenAt === "string",
            detail: JSON.stringify({ error, written, same: same(before, after), slot: slot && slot.status })
          };
        });
      });

      await check("sync backup: the next successful write clears the error", async () => {
        return scenario({}, async () => {
          await waitSlot(complete(rules(2)));
          await idle();
          const error = await overQuota(big);
          await idle();
          const failed = await status();
          const filler = Object.keys(await syncAll()).filter(key => key.startsWith("filler:"));
          await browser.storage.sync.remove(filler);
          await setStore({ groups: rules(3) });
          const slot = await waitSlot(complete(rules(3)));
          await idle();
          const written = await status();
          return {
            pass: Boolean(error) && Boolean(slot) && written?.error === null && typeof written.lastWrittenAt === "string" && written.lastWrittenAt > (failed?.lastWrittenAt ?? ""),
            detail: JSON.stringify({ error, failed, written })
          };
        });
      });

      await check("sync backup: an invalid stored rule is recorded and nothing is written", async () => {
        return scenario({}, async () => {
          await waitSlot(complete(rules(2)));
          await idle();
          const before = await slotItems();
          const watch = watchSync();
          try {
            await setStore({ groups: broken });
            const error = await until(async () => (await status())?.error);
            await idle();
            const after = await slotItems();
            return {
              pass: error === 'Rule "Broken" has no URL pattern.' && same(before, after) && watch.events.length === 0 && same(await liveGroups(), broken),
              detail: JSON.stringify({ error, same: same(before, after), events: watch.events })
            };
          } finally {
            watch.done();
          }
        });
      });

      await check("sync backup: the error clears when the stored rules match the slot again", async () => {
        return scenario({}, async () => {
          await waitSlot(complete(rules(2)));
          await idle();
          const before = await slotItems();
          await setStore({ groups: broken });
          const error = await until(async () => (await status())?.error);
          await idle();
          const watch = watchSync();
          try {
            await setStore({ groups: rules(2) });
            const cleared = await until(async () => (await status())?.error === null);
            await idle();
            const after = await slotItems();
            return {
              pass: Boolean(error) && Boolean(cleared) && same(before, after) && watch.events.length === 0,
              detail: JSON.stringify({ error, cleared: Boolean(cleared), same: same(before, after), events: watch.events })
            };
          } finally {
            watch.done();
          }
        });
      });

      await check("sync backup: a rule too large for one item is recorded and nothing is written", async () => {
        const huge = [rule(1), rule(2, { name: "n".repeat(9000) })];
        return scenario({}, async () => {
          await waitSlot(complete(rules(2)));
          await idle();
          const before = await slotItems();
          const watch = watchSync();
          try {
            await setStore({ groups: huge });
            const error = await until(async () => (await status())?.error);
            await idle();
            const after = await slotItems();
            return {
              pass: /^Rule 2 is too large to store in Firefox Sync \(\d+ bytes\)\.$/.test(error ?? "") && same(before, after) && watch.events.length === 0 && same(await liveGroups(), huge),
              detail: JSON.stringify({ error, same: same(before, after), events: watch.events })
            };
          } finally {
            watch.done();
          }
        });
      });

      await check("sync backup: loading the writer with the toggle on schedules a write, with the toggle off or never set it does not", async () => {
        const load = async () => {
          const frame = document.createElement("iframe");
          document.body.append(frame);
          const win = frame.contentWindow;
          const delays = [];
          win.setTimeout = (fn, ms) => {
            delays.push(ms);
            return 0;
          };
          for (const file of ["backup.js", "sync-backup.js"]) {
            await new Promise((resolve, reject) => {
              const script = frame.contentDocument.createElement("script");
              script.src = browser.runtime.getURL(file);
              script.onload = resolve;
              script.onerror = () => reject(new Error("could not load " + file));
              frame.contentDocument.head.append(script);
            });
          }
          await sleep(300);
          const loadedKnob = win.SYNC_BACKUP_DEBOUNCE_MS;
          frame.remove();
          return { delays, loadedKnob };
        };
        return scenario({}, async () => {
          await waitSlot(complete(rules(2)));
          await idle();
          const on = await load();
          await setStore({ syncBackupEnabled: false });
          await idle();
          const off = await load();
          await browser.storage.local.remove("syncBackupEnabled");
          const absent = await load();
          return {
            pass: typeof on.loadedKnob === "number" && same(on.delays, [on.loadedKnob]) && off.delays.length === 0 && absent.delays.length === 0,
            detail: JSON.stringify({ on, off, absent })
          };
        });
      });

      await check("sync backup: the writer checks leave storage.sync empty and the toggle off", async () => {
        await idle();
        const left = Object.keys(await syncAll());
        const { syncBackupEnabled } = await browser.storage.local.get("syncBackupEnabled");
        return { pass: left.length === 0 && syncBackupEnabled !== true && !bg.syncBackupTimer && !bg.syncBackupRunning, detail: JSON.stringify({ left, syncBackupEnabled }) };
      });
    } finally {
      bg.SYNC_BACKUP_DEBOUNCE_MS = knob;
      await idle();
      await browser.storage.local.clear();
      await setStore(saved);
      await idle();
    }
  }

  // ---------------------------------------------------------------- sync backup options section
  {
    const PREFIX = "atm-backup:";
    const ID = "0b9f2c1e-5d3a-4e7b-8c6d-1a2b3c4d5e6f";
    const ID_INC = "5e8f0a12-7b6c-4d3e-a1f0-9c8b7a6d5e4f";
    const ID_NEW = "3c4d5e6f-8a9b-4c1d-a2e3-4f5a6b7c8d9e";
    const SETTINGS = { groupUnmatched: true, groupSortMode: "alphabetical", groupColorMode: "assigned", selectedTabTheme: false };
    // SHA-256 of the hand-written text of the three rules below, computed with node:crypto (same fixture as the slot codec section).
    const FX_HASH = "fa060abca047da0c5e95f27383210935e1ef4ec90cad19764d5ea7f344a06b27";
    const metaOf = (label, extra) => ({
      format: 1,
      label,
      createdAt: "2026-09-30T10:00:00.000Z",
      active: true,
      chunkCount: 2,
      ruleCount: 3,
      hash: FX_HASH,
      schema: "advanced-tab-manager",
      version: 2,
      exportedAt: "2026-10-01T08:30:00.000Z",
      settings: SETTINGS,
      ...extra
    });
    const FX = {
      [`${PREFIX}${ID}:meta`]: metaOf("macOS 2026-09-30"),
      [`${PREFIX}${ID}:c0`]: [
        { name: "Work", pattern: "*work*", color: "blue", createdOrder: 1 },
        { name: 'Say "Merhaba" ş', pattern: "*ç\\ğ*|*ü*", color: "gray", createdOrder: 2 }
      ],
      [`${PREFIX}${ID}:c1`]: [{ name: "Docs", pattern: "*docs*", color: "red", createdOrder: 3 }]
    };
    const FX_INC = { [`${PREFIX}${ID_INC}:meta`]: metaOf("Windows 2026-09-29", { chunkCount: 1, ruleCount: 1 }) };
    const FX_NEW = { [`${PREFIX}${ID_NEW}:meta`]: metaOf("Linux 2026-10-01", { format: 99 }) };
    const local1 = { name: "Local only", pattern: "*local-only.example*", color: "green", createdOrder: 1 };

    const until = async (fn, ms = 8000) => {
      const end = Date.now() + ms;
      for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > end) return null;
        await sleep(60);
      }
    };
    const syncAll = () => browser.storage.sync.get(null);
    const clearSync = async () => {
      const keys = Object.keys(await syncAll()).filter(key => key.startsWith(PREFIX));
      if (keys.length > 0) await browser.storage.sync.remove(keys);
    };
    const idle = async () => {
      let calm = 0;
      await until(async () => {
        calm = !bg.syncBackupTimer && !bg.syncBackupRunning ? calm + 1 : 0;
        return calm >= 3;
      }, 8000);
    };
    const rowFor = (view, id) => view.document.querySelector(`#syncSlotList li[data-device-id="${id}"]`);
    const rowButtons = (view, id) => {
      const row = rowFor(view, id);
      return row ? { restore: row.querySelector(".slot-restore"), remove: row.querySelector(".slot-delete"), text: row.textContent } : null;
    };
    const names = async () => (await browser.storage.local.get("groups")).groups.map(g => g.name);
    const saved = await browser.storage.local.get(null);
    const knob = bg.SYNC_BACKUP_DEBOUNCE_MS;
    let tabId = null;

    try {
      bg.SYNC_BACKUP_DEBOUNCE_MS = 300;
      await idle();
      await clearSync();
      await browser.storage.local.remove(["syncBackupEnabled", "syncBackupDeviceId", "syncBackupStatus"]);
      await setStore({ groups: [local1], ...SETTINGS });
      await browser.storage.sync.set({ ...FX, ...FX_INC, ...FX_NEW });
      const view = await openExtensionPage("options.html");
      tabId = (await view.browser.tabs.getCurrent()).id;

      await check("options sync backup: list shows each foreign slot with its state and gates restore", async () => {
        const ready = await until(() => view.document.querySelectorAll("#syncSlotList li").length === 3);
        const ok = rowButtons(view, ID);
        const inc = rowButtons(view, ID_INC);
        const unk = rowButtons(view, ID_NEW);
        const pass =
          Boolean(ready && ok && inc && unk) &&
          ok.restore.disabled === false && ok.text.includes("macOS 2026-09-30") && ok.text.includes("3 rule(s)") && !ok.text.includes("this device") &&
          inc.restore.disabled === true && inc.text.includes("incomplete") &&
          unk.restore.disabled === true && unk.text.includes("unknown format") &&
          view.document.getElementById("syncBackupEnabled").checked === false;
        return { pass, detail: JSON.stringify({ ready: Boolean(ready), ok: ok?.text, inc: inc?.text, unk: unk?.text }) };
      });

      await check("options sync backup: restore replaces the rules with the slot and the confirm names the mode and device", async () => {
        const seen = [];
        view.confirm = message => { seen.push(message); return true; };
        rowButtons(view, ID).restore.click();
        const replaced = await until(async () => (await names()).join("|") === ["Work", 'Say "Merhaba" ş', "Docs"].join("|"));
        return {
          pass: Boolean(replaced) && seen.length === 1 && seen[0].includes("Replace all rules") && seen[0].includes("macOS 2026-09-30"),
          detail: JSON.stringify({ names: await names(), seen })
        };
      });

      await check("options sync backup: restore in merge mode keeps a local-only rule", async () => {
        const seen = [];
        view.confirm = message => { seen.push(message); return true; };
        await setStore({ groups: [local1] });
        view.document.querySelector('input[name="importMode"][value="merge"]').checked = true;
        try {
          rowButtons(view, ID).restore.click();
          const merged = await until(async () => (await names()).length === 4);
          const now = await names();
          return {
            pass: Boolean(merged) && now.includes("Local only") && now.includes("Work") && now.includes("Docs") && seen.length === 1 && seen[0].includes("Merge"),
            detail: JSON.stringify({ now, seen })
          };
        } finally {
          view.document.querySelector('input[name="importMode"][value="replace"]').checked = true;
          view.confirm = () => true;
        }
      });

      await check("options sync backup: a slot arriving from Sync updates the list without touching the rules list or the rules", async () => {
        const before = await names();
        const original = view.refreshList;
        let calls = 0;
        view.refreshList = (...args) => { calls += 1; return original(...args); };
        try {
          const extra = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
          await browser.storage.sync.set({ [`${PREFIX}${extra}:meta`]: metaOf("Android 2026-10-01", { format: 99 }) });
          const shown = await until(() => rowFor(view, extra));
          await sleep(500);
          await browser.storage.sync.remove(`${PREFIX}${extra}:meta`);
          const gone = await until(() => !rowFor(view, extra));
          return { pass: Boolean(shown && gone) && calls === 0 && (await names()).join("|") === before.join("|"), detail: JSON.stringify({ calls, before, after: await names() }) };
        } finally {
          view.refreshList = original;
        }
      });

      await check("options sync backup: deleting another device's slot removes all its keys and no other", async () => {
        rowButtons(view, ID).remove.click();
        const gone = await until(async () => !Object.keys(await syncAll()).some(key => key.startsWith(`${PREFIX}${ID}:`)));
        const left = Object.keys(await syncAll()).filter(key => key.startsWith(PREFIX)).sort();
        const rowGone = await until(() => !rowFor(view, ID));
        return {
          pass: Boolean(gone && rowGone) && JSON.stringify(left) === JSON.stringify([`${PREFIX}${ID_NEW}:meta`, `${PREFIX}${ID_INC}:meta`].sort()),
          detail: JSON.stringify({ left })
        };
      });

      await check("options sync backup: turning the toggle on with foreign slots present shows the offer; own delete is disabled while on", async () => {
        await setStore({ groups: [local1] });
        view.document.getElementById("syncBackupEnabled").click();
        const offer = await until(() => view.document.getElementById("syncBackupOffer").textContent.includes("other devices"));
        const own = await until(async () => {
          const { syncBackupDeviceId } = await browser.storage.local.get("syncBackupDeviceId");
          return syncBackupDeviceId && rowButtons(view, syncBackupDeviceId)?.text.includes("this device") ? syncBackupDeviceId : null;
        });
        const row = own && rowButtons(view, own);
        const state = view.document.getElementById("syncBackupState").textContent;
        const untouched = (await names()).join("|") === "Local only";
        return {
          pass: Boolean(offer && own) && row.remove.disabled === true && view.document.getElementById("syncSlotList").classList.contains("offered") && untouched,
          detail: JSON.stringify({ offer: Boolean(offer), own, state, untouched })
        };
      });

      await check("options sync backup: turning the toggle off marks the own slot stopped and enables its delete", async () => {
        await idle();
        const { syncBackupDeviceId } = await browser.storage.local.get("syncBackupDeviceId");
        view.document.getElementById("syncBackupEnabled").click();
        const stopped = await until(() => {
          const row = rowButtons(view, syncBackupDeviceId);
          return row && row.text.includes("stopped") && row.remove.disabled === false;
        });
        const offerGone = view.document.getElementById("syncBackupOffer").textContent === "";
        await idle();
        rowButtons(view, syncBackupDeviceId).remove.click();
        const removed = await until(async () => !Object.keys(await syncAll()).some(key => key.startsWith(`${PREFIX}${syncBackupDeviceId}:`)));
        return { pass: Boolean(stopped && removed) && offerGone, detail: JSON.stringify({ stopped: Boolean(stopped), removed: Boolean(removed), offerGone }) };
      });
    } finally {
      bg.SYNC_BACKUP_DEBOUNCE_MS = knob;
      await setStore({ syncBackupEnabled: false });
      await idle();
      await clearSync();
      if (tabId !== null) await browser.tabs.remove(tabId);
      await browser.storage.local.clear();
      await setStore(saved);
      await applyAll();
      await idle();
    }

    await check("options sync backup: the section leaves storage.sync empty and the toggle off", async () => {
      const left = Object.keys(await syncAll()).filter(key => key.startsWith(PREFIX));
      const { syncBackupEnabled } = await browser.storage.local.get("syncBackupEnabled");
      return { pass: left.length === 0 && syncBackupEnabled !== true, detail: JSON.stringify({ left, syncBackupEnabled }) };
    });
  }

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
