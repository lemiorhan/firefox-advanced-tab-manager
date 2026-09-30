// Advanced Tab Manager - Firefox background script

const UNGROUPED_ID = -1;
const UNMATCHED_GROUP_NAME = "etc";
const UNMATCHED_GROUP_COLOR = "grey";

const VALID_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
]);

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

function normalizeColor(color, fallback = "blue") {
  const normalized =
    color === "gray"
      ? "grey"
      : color;

  return VALID_COLORS.has(normalized)
    ? normalized
    : fallback;
}

function shuffle(items) {
  const shuffled = [...items];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(
      Math.random() * (i + 1)
    );

    [shuffled[i], shuffled[j]] =
      [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

function randomGroupColor(
  usedColors = [],
  forbiddenColors = []
) {
  const allowed = [...VALID_COLORS].filter(
    color => !forbiddenColors.includes(color)
  );

  const unused = allowed.filter(
    color => !usedColors.includes(color)
  );

  const candidates =
    unused.length > 0
      ? unused
      : allowed;

  return candidates[
    Math.floor(Math.random() * candidates.length)
  ];
}

function normalizeGroupName(name) {
  return String(name || "")
    .trim()
    .toLocaleLowerCase();
}

function compareGroupNames(a, b) {
  return String(a || "").localeCompare(
    String(b || ""),
    undefined,
    {
      sensitivity: "base",
      numeric: true
    }
  );
}

// -----------------------------------------------------------------------------
// Wildcard matching
// -----------------------------------------------------------------------------

// "|" separates alternatives: "*github.com*|*localhost*" matches either one.
function wildcardMatch(url, pattern) {
  if (!url || !pattern) {
    return false;
  }

  return String(pattern)
    .split("|")
    .some(
      (alternative) =>
        matchesSinglePattern(
          url,
          alternative
        )
    );
}

function matchesSinglePattern(url, pattern) {
  try {
    const parsedUrl = new URL(url);

    const hostname = parsedUrl.hostname;

    const target =
      `${hostname}${parsedUrl.pathname}${parsedUrl.search}`;

    const targetWithoutWww =
      `${hostname.replace(/^www\./i, "")}` +
      `${parsedUrl.pathname}${parsedUrl.search}`;

    const normalizedPattern = String(pattern)
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "");

    if (!normalizedPattern) {
      return false;
    }

    // Escape regex metacharacters except "*".
    // "*" is converted to the extension's wildcard.
    const regexPattern = normalizedPattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");

    const regex =
      new RegExp(regexPattern, "i");

    return (
      regex.test(hostname) ||
      regex.test(target) ||
      regex.test(targetWithoutWww)
    );
  } catch (error) {
    console.warn(
      "matchesSinglePattern failed:",
      {
        url,
        pattern,
        error
      }
    );

    return false;
  }
}

// -----------------------------------------------------------------------------
// Rule metadata migration
// -----------------------------------------------------------------------------

function normalizeCreatedOrders(groups) {
  const result =
    groups.map(group => ({
      ...group
    }));

  const usedOrders =
    new Set();

  let maxOrder =
    result.reduce(
      (max, group) => {
        if (
          Number.isInteger(group.createdOrder) &&
          group.createdOrder > 0
        ) {
          return Math.max(
            max,
            group.createdOrder
          );
        }

        return max;
      },
      0
    );

  let nextOrder =
    maxOrder + 1;

  let changed = false;

  for (const group of result) {
    const valid =
      Number.isInteger(group.createdOrder) &&
      group.createdOrder > 0 &&
      !usedOrders.has(group.createdOrder);

    if (valid) {
      usedOrders.add(
        group.createdOrder
      );

      continue;
    }

    group.createdOrder =
      nextOrder++;

    usedOrders.add(
      group.createdOrder
    );

    changed = true;
  }

  return {
    groups: result,
    changed
  };
}

async function migrateStorage() {
  const {
    groups = [],
    groupSortMode = "alphabetical"
  } =
    await browser.storage.local.get([
      "groups",
      "groupSortMode"
    ]);

  const normalized =
    normalizeCreatedOrders(
      Array.isArray(groups)
        ? groups
        : []
    );

  const updates = {};

  if (normalized.changed) {
    updates.groups =
      normalized.groups;
  }

  if (
    groupSortMode !== "creation" &&
    groupSortMode !== "alphabetical"
  ) {
    updates.groupSortMode =
      "alphabetical";
  }

  if (
    Object.keys(updates).length > 0
  ) {
    await browser.storage.local.set(
      updates
    );
  }

  // Legacy implementation persisted Firefox group IDs.
  // They aren't stable across sessions.
  await browser.storage.local.remove(
    "groupMap"
  );
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

async function getSettings() {
  const {
    groups = [],
    groupUnmatched = true,
    groupSortMode = "alphabetical",
    groupColorMode = "assigned"
  } =
    await browser.storage.local.get([
      "groups",
      "groupUnmatched",
      "groupSortMode",
      "groupColorMode"
    ]);

  return {
    groups:
      Array.isArray(groups)
        ? groups
        : [],

    groupUnmatched,

    groupSortMode:
      groupSortMode === "creation"
        ? "creation"
        : "alphabetical",

    groupColorMode:
      groupColorMode === "random"
        ? "random"
        : "assigned"
  };
}

function findMatchingRule(
  url,
  groups
) {
  if (!url) {
    return null;
  }

  for (const group of groups) {
    if (
      !group?.name ||
      !group?.pattern
    ) {
      continue;
    }

    if (
      wildcardMatch(
        url,
        group.pattern
      )
    ) {
      return group;
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Per-window operation queue
// -----------------------------------------------------------------------------

const windowQueues =
  new Map();

function enqueueWindowOperation(
  windowId,
  operation
) {
  const previous =
    windowQueues.get(windowId) ||
    Promise.resolve();

  const next =
    previous
      .catch(() => {
        // A failed operation should not poison the queue.
      })
      .then(operation)
      .finally(() => {
        if (
          windowQueues.get(windowId) ===
          next
        ) {
          windowQueues.delete(
            windowId
          );
        }
      });

  windowQueues.set(
    windowId,
    next
  );

  return next;
}

// -----------------------------------------------------------------------------
// Group lookup
// -----------------------------------------------------------------------------

// Managed group titles carry their tab count, e.g. "zoom(4)", so a group is
// identified by its title with that suffix removed.
const TAB_COUNT_SUFFIX = /\(\d+\)$/;

function groupNameOf(group) {
  return String(group?.title || "").replace(
    TAB_COUNT_SUFFIX,
    ""
  );
}

function groupTitle(name, tabCount) {
  return `${name}(${tabCount})`;
}

async function findGroups(
  windowId,
  name
) {
  const query =
    windowId == null
      ? {}
      : { windowId };

  try {
    const groups =
      await browser.tabGroups.query(
        query
      );

    return groups.filter(
      group =>
        normalizeGroupName(
          groupNameOf(group)
        ) ===
        normalizeGroupName(name)
    );
  } catch (error) {
    console.error(
      `Could not query group "${name}" in window ${windowId}:`,
      error
    );

    return [];
  }
}

async function findGroup(
  windowId,
  name
) {
  const groups =
    await findGroups(
      windowId,
      name
    );

  return groups.length > 0
    ? groups[0]
    : null;
}

async function countTabsInGroup(
  groupId,
  excludedTabId
) {
  const tabs =
    await browser.tabs.query({
      groupId
    });

  return tabs.filter(
    tab => tab.id !== excludedTabId
  ).length;
}

async function updateGroupAppearance(
  group,
  name,
  color
) {
  const normalizedColor =
    color == null
      ? group.color
      : normalizeColor(color);

  const title = groupTitle(
    name,
    await countTabsInGroup(group.id)
  );

  const needsUpdate =
    group.title !== title ||
    group.color !== normalizedColor;

  if (!needsUpdate) {
    return group;
  }

  try {
    return await browser.tabGroups.update(
      group.id,
      {
        title,
        color: normalizedColor
      }
    );
  } catch (error) {
    console.warn(
      `Could not update group "${title}" (${group.id}):`,
      error
    );

    return group;
  }
}

async function getManagedGroups(
  windowId
) {
  const {
    groups: rules,
    groupUnmatched
  } = await getSettings();

  const namesByKey = new Map(
    rules.map(rule => [
      normalizeGroupName(rule.name),
      rule.name
    ])
  );

  if (groupUnmatched) {
    namesByKey.set(
      normalizeGroupName(
        UNMATCHED_GROUP_NAME
      ),
      UNMATCHED_GROUP_NAME
    );
  }

  const windowGroups =
    await browser.tabGroups.query({
      windowId
    });

  return windowGroups
    .map(group => ({
      group,
      name: namesByKey.get(
        normalizeGroupName(
          groupNameOf(group)
        )
      )
    }))
    .filter(({ name }) => name != null);
}

async function updateTabCountsInWindow(
  windowId,
  removedTabId
) {
  const managed =
    await getManagedGroups(windowId);

  for (const { group, name } of managed) {
    const title = groupTitle(
      name,
      await countTabsInGroup(
        group.id,
        removedTabId
      )
    );

    if (group.title === title) {
      continue;
    }

    try {
      await browser.tabGroups.update(
        group.id,
        { title }
      );
    } catch (error) {
      console.warn(
        `Could not update title of group ${group.id}:`,
        error
      );
    }
  }
}

function refreshTabCounts(
  windowId,
  removedTabId
) {
  if (windowId == null) {
    return;
  }

  enqueueWindowOperation(
    windowId,
    () =>
      updateTabCountsInWindow(
        windowId,
        removedTabId
      )
  ).catch(error => {
    console.warn(
      `Could not update tab counts in window ${windowId}:`,
      error
    );
  });
}

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    refreshTabCounts(tab.windowId);
  },
  { properties: ["groupId"] }
);

async function expandGroupOfActiveTab(tab) {
  if (
    !tab.active ||
    tab.groupId == null ||
    tab.groupId === UNGROUPED_ID
  ) {
    return;
  }

  const group =
    await browser.tabGroups.get(
      tab.groupId
    );

  if (group.collapsed) {
    await browser.tabGroups.update(
      group.id,
      { collapsed: false }
    );
  }
}

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    expandGroupOfActiveTab(tab).catch(
      error => {
        console.warn(
          `Could not expand the group of tab ${tabId}:`,
          error
        );
      }
    );
  },
  { properties: ["groupId"] }
);

browser.tabs.onRemoved.addListener(
  (tabId, { windowId, isWindowClosing }) => {
    if (!isWindowClosing) {
      refreshTabCounts(windowId, tabId);
    }
  }
);

browser.tabs.onDetached.addListener(
  (tabId, { oldWindowId }) => {
    refreshTabCounts(oldWindowId, tabId);
  }
);

// -----------------------------------------------------------------------------
// Ensure tabs are in target group
// -----------------------------------------------------------------------------

async function ensureTabsInGroup(
  windowId,
  groupName,
  color,
  tabs
) {
  if (
    !tabs ||
    tabs.length === 0
  ) {
    return null;
  }

  const windowTabs =
    tabs.filter(
      tab =>
        tab?.id != null &&
        tab.windowId === windowId
    );

  if (
    windowTabs.length === 0
  ) {
    return null;
  }

  const { groupColorMode } =
    await getSettings();

  let group =
    await findGroup(
      windowId,
      groupName
    );

  let appearanceColor = color;

  if (!group) {
    if (groupColorMode === "random") {
      const windowGroups =
        await browser.tabGroups.query({
          windowId
        });

      appearanceColor =
        randomGroupColor(
          windowGroups.map(
            windowGroup => windowGroup.color
          )
        );
    }

    try {
      const groupId =
        await browser.tabs.group({
          tabIds:
            windowTabs.map(
              tab => tab.id
            ),

          createProperties: {
            windowId
          }
        });

      group =
        await browser.tabGroups.get(
          groupId
        );

      console.debug(
        `Created group "${groupName}" in window ${windowId}`,
        groupId
      );
    } catch (error) {
      console.error(
        `Could not create group "${groupName}" in window ${windowId}:`,
        error
      );

      return null;
    }
  } else {
    // Random colors are assigned on creation and on switching to random mode;
    // re-applying rules must not reshuffle them.
    if (groupColorMode === "random") {
      appearanceColor = null;
    }

    const tabsToMove =
      windowTabs.filter(
        tab =>
          tab.groupId !== group.id
      );

    if (
      tabsToMove.length > 0
    ) {
      try {
        await browser.tabs.group({
          groupId: group.id,

          tabIds:
            tabsToMove.map(
              tab => tab.id
            )
        });

        console.debug(
          `Moved ${tabsToMove.length} tab(s) into "${groupName}"`,
          group.id
        );
      } catch (error) {
        console.error(
          `Could not add tabs to group "${groupName}":`,
          error
        );

        return null;
      }
    }
  }

  return updateGroupAppearance(
    group,
    groupName,
    appearanceColor
  );
}

// -----------------------------------------------------------------------------
// Group sorting
// -----------------------------------------------------------------------------

async function sortGroupsInWindow(
  windowId
) {
  const {
    groups: rules,
    groupUnmatched,
    groupSortMode
  } =
    await getSettings();

  let actualGroups;

  try {
    actualGroups =
      await browser.tabGroups.query({
        windowId
      });
  } catch (error) {
    console.error(
      `Could not query groups for window ${windowId}:`,
      error
    );

    return;
  }

  if (
    actualGroups.length < 2
  ) {
    return;
  }

  const ruleByName =
    new Map();

  rules.forEach(
    (rule, index) => {
      ruleByName.set(
        normalizeGroupName(
          rule.name
        ),
        {
          rule,
          index
        }
      );
    }
  );

  // Only groups managed by this extension participate.
  const managedGroups =
    actualGroups.filter(
      group => {
        if (
          ruleByName.has(
            normalizeGroupName(
              groupNameOf(group)
            )
          )
        ) {
          return true;
        }

        return (
          groupUnmatched &&
          normalizeGroupName(
            groupNameOf(group)
          ) ===
            normalizeGroupName(
              UNMATCHED_GROUP_NAME
            )
        );
      }
    );

  if (
    managedGroups.length < 2
  ) {
    return;
  }

  if (
    groupSortMode ===
    "alphabetical"
  ) {
    managedGroups.sort(
      (a, b) =>
        compareGroupNames(
          groupNameOf(a),
          groupNameOf(b)
        )
    );
  } else {
    managedGroups.sort(
      (a, b) => {
        const aRule =
          ruleByName.get(
            normalizeGroupName(
              groupNameOf(a)
            )
          );

        const bRule =
          ruleByName.get(
            normalizeGroupName(
              groupNameOf(b)
            )
          );

        // "etc" is synthetic. Keep it after
        // explicitly-created rules in creation mode.
        const aOrder =
          normalizeGroupName(
            groupNameOf(a)
          ) ===
          normalizeGroupName(
            UNMATCHED_GROUP_NAME
          )
            ? Number.MAX_SAFE_INTEGER
            : (
                aRule?.rule
                  ?.createdOrder ??
                aRule?.index ??
                Number.MAX_SAFE_INTEGER
              );

        const bOrder =
          normalizeGroupName(
            groupNameOf(b)
          ) ===
          normalizeGroupName(
            UNMATCHED_GROUP_NAME
          )
            ? Number.MAX_SAFE_INTEGER
            : (
                bRule?.rule
                  ?.createdOrder ??
                bRule?.index ??
                Number.MAX_SAFE_INTEGER
              );

        if (
          aOrder !== bOrder
        ) {
          return aOrder - bOrder;
        }

        return compareGroupNames(
          groupNameOf(a),
          groupNameOf(b)
        );
      }
    );
  }

  let tabs;

  try {
    tabs =
      await browser.tabs.query({
        windowId
      });
  } catch (error) {
    console.error(
      `Could not query tabs for sorting in window ${windowId}:`,
      error
    );

    return;
  }

  const managedIds =
    new Set(
      managedGroups.map(
        group => group.id
      )
    );

  const managedTabs =
    tabs.filter(
      tab =>
        managedIds.has(
          tab.groupId
        )
    );

  if (
    managedTabs.length === 0
  ) {
    return;
  }

  let targetIndex =
    Math.min(
      ...managedTabs.map(
        tab => tab.index
      )
    );

  for (
    const group of managedGroups
  ) {
    let groupTabs;

    try {
      groupTabs =
        await browser.tabs.query({
          groupId: group.id
        });
    } catch (error) {
      console.warn(
        `Could not query tabs for group ${group.id}:`,
        error
      );

      continue;
    }

    if (
      groupTabs.length === 0
    ) {
      continue;
    }

    groupTabs.sort(
      (a, b) =>
        a.index - b.index
    );

    const currentIndex =
      groupTabs[0].index;

    if (
      currentIndex !== targetIndex
    ) {
      try {
        await browser.tabGroups.move(
          group.id,
          {
            index: targetIndex
          }
        );
      } catch (error) {
        console.warn(
          `Could not move group "${group.title}":`,
          error
        );
      }
    }

    targetIndex +=
      groupTabs.length;
  }

  await separateAdjacentGroupColors(
    windowId
  );
}

async function sortAllGroups() {
  let tabs;

  try {
    tabs =
      await browser.tabs.query({});
  } catch (error) {
    console.error(
      "Could not query tabs:",
      error
    );

    return;
  }

  const windowIds = [
    ...new Set(
      tabs
        .map(
          tab => tab.windowId
        )
        .filter(
          windowId =>
            windowId != null
        )
    )
  ];

  await Promise.all(
    windowIds.map(
      windowId =>
        enqueueWindowOperation(
          windowId,
          () =>
            sortGroupsInWindow(
              windowId
            )
        )
    )
  );
}

// -----------------------------------------------------------------------------
// Process one tab
// -----------------------------------------------------------------------------

async function applyRuleToTab(
  tabId
) {
  let tab;

  try {
    tab =
      await browser.tabs.get(
        tabId
      );
  } catch {
    // Tab may have been closed before its queued task ran.
    return;
  }

  if (
    !tab?.url ||
    tab.id == null
  ) {
    return;
  }

  const {
    groups,
    groupUnmatched
  } =
    await getSettings();

  const matchedGroup =
    findMatchingRule(
      tab.url,
      groups
    );

  if (matchedGroup) {
    await ensureTabsInGroup(
      tab.windowId,
      matchedGroup.name,
      matchedGroup.color ||
        "blue",
      [tab]
    );

    return;
  }

  if (groupUnmatched) {
    await ensureTabsInGroup(
      tab.windowId,
      UNMATCHED_GROUP_NAME,
      UNMATCHED_GROUP_COLOR,
      [tab]
    );

    return;
  }

  if (
    tab.groupId != null &&
    tab.groupId !==
      UNGROUPED_ID
  ) {
    try {
      await browser.tabs.ungroup(
        [tab.id]
      );
    } catch (error) {
      console.warn(
        `Could not ungroup tab ${tab.id}:`,
        error
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Reconcile a complete window
// -----------------------------------------------------------------------------

async function reconcileWindow(
  windowId
) {
  const {
    groups,
    groupUnmatched
  } =
    await getSettings();

  let tabs;

  try {
    tabs =
      await browser.tabs.query({
        windowId
      });
  } catch (error) {
    console.error(
      `Could not query tabs for window ${windowId}:`,
      error
    );

    return;
  }

  const targetGroups =
    new Map();

  const unmatchedTabs = [];

  for (const tab of tabs) {
    if (
      !tab.url ||
      tab.id == null
    ) {
      continue;
    }

    const matchedGroup =
      findMatchingRule(
        tab.url,
        groups
      );

    if (!matchedGroup) {
      unmatchedTabs.push(
        tab
      );

      continue;
    }

    if (
      !targetGroups.has(
        matchedGroup.name
      )
    ) {
      targetGroups.set(
        matchedGroup.name,
        {
          color:
            matchedGroup.color ||
            "blue",

          tabs: []
        }
      );
    }

    targetGroups
      .get(matchedGroup.name)
      .tabs
      .push(tab);
  }

  for (
    const [
      groupName,
      target
    ] of targetGroups
  ) {
    await ensureTabsInGroup(
      windowId,
      groupName,
      target.color,
      target.tabs
    );
  }

  if (groupUnmatched) {
    if (
      unmatchedTabs.length > 0
    ) {
      await ensureTabsInGroup(
        windowId,
        UNMATCHED_GROUP_NAME,
        UNMATCHED_GROUP_COLOR,
        unmatchedTabs
      );
    }
  } else {
    const tabsToUngroup =
      unmatchedTabs
        .filter(
          tab =>
            tab.groupId != null &&
            tab.groupId !==
              UNGROUPED_ID
        )
        .map(
          tab => tab.id
        );

    if (
      tabsToUngroup.length > 0
    ) {
      try {
        await browser.tabs.ungroup(
          tabsToUngroup
        );
      } catch (error) {
        console.error(
          `Could not ungroup unmatched tabs in window ${windowId}:`,
          error
        );
      }
    }
  }

  await sortGroupsInWindow(
    windowId
  );
}

// -----------------------------------------------------------------------------
// Apply rules to every existing tab
// -----------------------------------------------------------------------------

async function applyRulesToAllTabs() {
  let tabs;

  try {
    tabs =
      await browser.tabs.query({});
  } catch (error) {
    console.error(
      "Could not query tabs:",
      error
    );

    return;
  }

  const windowIds = [
    ...new Set(
      tabs
        .map(
          tab => tab.windowId
        )
        .filter(
          windowId =>
            windowId != null
        )
    )
  ];

  await Promise.all(
    windowIds.map(
      windowId =>
        enqueueWindowOperation(
          windowId,
          () =>
            reconcileWindow(
              windowId
            )
        )
    )
  );
}

// -----------------------------------------------------------------------------
// Update group color
// -----------------------------------------------------------------------------

async function updateGroupColor(
  groupName,
  newColor
) {
  const { groupColorMode } =
    await getSettings();

  if (groupColorMode === "random") {
    return;
  }

  const groups =
    await findGroups(
      undefined,
      groupName
    );

  const color =
    normalizeColor(
      newColor
    );

  await Promise.all(
    groups.map(
      async group => {
        try {
          await browser.tabGroups.update(
            group.id,
            {
              color
            }
          );
        } catch (error) {
          console.warn(
            `Could not update color of group ${group.id}:`,
            error
          );
        }
      }
    )
  );
}

async function randomizeGroupColorsInWindow(
  windowId
) {
  const managed =
    await getManagedGroups(windowId);

  let palette = [];

  for (const { group } of managed) {
    if (palette.length === 0) {
      palette = shuffle(VALID_COLORS);
    }

    try {
      await browser.tabGroups.update(
        group.id,
        {
          color: palette.pop()
        }
      );
    } catch (error) {
      console.warn(
        `Could not update color of group ${group.id}:`,
        error
      );
    }
  }

  await separateAdjacentGroupColors(
    windowId
  );
}

async function separateAdjacentGroupColors(
  windowId
) {
  const { groupColorMode } =
    await getSettings();

  if (groupColorMode !== "random") {
    return;
  }

  const managedIds = new Set(
    (await getManagedGroups(windowId))
      .map(({ group }) => group.id)
  );

  const tabs =
    await browser.tabs.query({
      windowId
    });

  const orderedGroupIds = [];

  tabs
    .sort((a, b) => a.index - b.index)
    .forEach(tab => {
      if (
        tab.groupId !== UNGROUPED_ID &&
        tab.groupId !==
          orderedGroupIds.at(-1)
      ) {
        orderedGroupIds.push(
          tab.groupId
        );
      }
    });

  const groups = await Promise.all(
    orderedGroupIds.map(id =>
      browser.tabGroups.get(id)
    )
  );

  for (let i = 1; i < groups.length; i++) {
    if (groups[i].color !== groups[i - 1].color) {
      continue;
    }

    const index =
      managedIds.has(groups[i].id)
        ? i
        : i - 1;

    if (!managedIds.has(groups[index].id)) {
      continue;
    }

    const color = randomGroupColor(
      groups.map(group => group.color),
      [
        groups[index - 1]?.color,
        groups[index + 1]?.color
      ]
    );

    try {
      await browser.tabGroups.update(
        groups[index].id,
        { color }
      );

      groups[index] = {
        ...groups[index],
        color
      };
    } catch (error) {
      console.warn(
        `Could not update color of group ${groups[index].id}:`,
        error
      );
    }
  }
}

async function randomizeAllGroupColors() {
  const windows =
    await browser.windows.getAll();

  await Promise.all(
    windows.map(({ id }) =>
      enqueueWindowOperation(
        id,
        () =>
          randomizeGroupColorsInWindow(id)
      )
    )
  );
}

browser.storage.onChanged.addListener(
  (changes, areaName) => {
    const change =
      changes.groupColorMode;

    if (
      areaName !== "local" ||
      change?.newValue !== "random" ||
      change.oldValue === "random"
    ) {
      return;
    }

    randomizeAllGroupColors().catch(
      error => {
        console.error(
          "Could not randomize group colors:",
          error
        );
      }
    );
  }
);

// -----------------------------------------------------------------------------
// Ungroup tabs no longer matching a modified rule
// -----------------------------------------------------------------------------

async function ungroupMismatchedTabs(
  groupName,
  newPattern
) {
  const matchingGroups =
    await findGroups(
      undefined,
      groupName
    );

  await Promise.all(
    matchingGroups.map(
      group =>
        enqueueWindowOperation(
          group.windowId,
          async () => {
            let tabs;

            try {
              tabs =
                await browser.tabs.query({
                  groupId:
                    group.id
                });
            } catch (error) {
              console.warn(
                `Could not query tabs for group ${group.id}:`,
                error
              );

              return;
            }

            const tabsToUngroup =
              tabs
                .filter(
                  tab =>
                    !tab.url ||
                    !wildcardMatch(
                      tab.url,
                      newPattern
                    )
                )
                .map(
                  tab => tab.id
                )
                .filter(
                  id => id != null
                );

            if (
              tabsToUngroup.length ===
              0
            ) {
              return;
            }

            try {
              await browser.tabs.ungroup(
                tabsToUngroup
              );
            } catch (error) {
              console.error(
                `Could not ungroup tabs from "${groupName}":`,
                error
              );
            }
          }
        )
    )
  );
}

// -----------------------------------------------------------------------------
// Runtime messages
// -----------------------------------------------------------------------------

browser.runtime.onMessage.addListener(
  message => {
    if (
      message.action ===
      "applyRulesToAllTabs"
    ) {
      return applyRulesToAllTabs()
        .then(() => ({
          success: true
        }))
        .catch(error => ({
          success: false,
          error: String(error)
        }));
    }

    if (
      message.action ===
      "updateGroupColor"
    ) {
      return updateGroupColor(
        message.groupName,
        message.newColor
      )
        .then(() => ({
          success: true
        }))
        .catch(error => ({
          success: false,
          error: String(error)
        }));
    }

    if (
      message.action ===
      "ungroupMismatchedTabs"
    ) {
      return ungroupMismatchedTabs(
        message.groupName,
        message.newPattern
      )
        .then(() => ({
          success: true
        }))
        .catch(error => ({
          success: false,
          error: String(error)
        }));
    }

    if (
      message.action ===
      "sortAllGroups"
    ) {
      return sortAllGroups()
        .then(() => ({
          success: true
        }))
        .catch(error => ({
          success: false,
          error: String(error)
        }));
    }

    return undefined;
  }
);

// -----------------------------------------------------------------------------
// URL changes
// -----------------------------------------------------------------------------

browser.tabs.onUpdated.addListener(
  (
    tabId,
    changeInfo,
    tab
  ) => {
    // A tab that stays on about:blank reports no URL change, and onCreated
    // leaves it alone, so it is picked up once it finishes loading.
    const stayedBlank =
      changeInfo.status === "complete" &&
      tab.url === "about:blank";

    if (!changeInfo.url && !stayedBlank) {
      return;
    }

    processTab(
      tab.windowId,
      tabId
    );
  }
);

// A new tab has no URL change to report when it opens on its initial page,
// such as about:newtab, so it would stay out of "etc" until it navigates.
// A tab opened from a link starts as about:blank and reports its real URL
// later; grouping it now would send it through "etc" first.
browser.tabs.onCreated.addListener(
  tab => {
    if (tab.url === "about:blank") {
      return;
    }

    processTab(
      tab.windowId,
      tab.id
    );
  }
);

// Firefox drops a tab's group when it moves to another window.
browser.tabs.onAttached.addListener(
  (tabId, { newWindowId }) => {
    processTab(
      newWindowId,
      tabId
    );
  }
);

function processTab(
  windowId,
  tabId
) {
  if (windowId == null) {
    return;
  }

  enqueueWindowOperation(
    windowId,
    async () => {
      await applyRuleToTab(
        tabId
      );

      await sortGroupsInWindow(
        windowId
      );
    }
  ).catch(error => {
    console.error(
      `Could not process tab ${tabId}:`,
      error
    );
  });
}

// -----------------------------------------------------------------------------
// Selected tab theme
// -----------------------------------------------------------------------------
//
// Extensions cannot style individual tabs, only a window's theme, and any
// extension theme replaces the installed one: colors it leaves out fall back to
// white and black rather than to the native look. So this applies a complete
// palette of its own. theme.update() takes no dark_theme, so the light or dark
// palette is picked here from the OS setting. The hex values are Firefox's own
// design tokens: selected tabs use --color-<name>-10 in light and
// --color-<name>-70 in dark.

const THEME_PALETTES = {
  light: {
    colors: {
      frame: "#efedf2",
      tab_background_text: "#15141a",
      toolbar: "#fcfbff",
      toolbar_text: "#15141a",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#15141a",
      popup: "#fcfbff",
      popup_text: "#15141a",
      sidebar: "#fcfbff",
      sidebar_text: "#15141a",
      tab_text: "#15141a"
    },
    selectedTab: {
      blue: "#c5eafe",
      cyan: "#c3eef8",
      green: "#c4f1e0",
      orange: "#ffdbc5",
      pink: "#ffd5ee",
      purple: "#f6d7ff",
      red: "#ffd9df",
      yellow: "#fde8b5",
      grey: "#d6d5da"
    }
  },
  dark: {
    colors: {
      frame: "#1d1b1f",
      tab_background_text: "#fbfbfe",
      toolbar: "#312f33",
      toolbar_text: "#fbfbfe",
      toolbar_field: "#1d1b1f",
      toolbar_field_text: "#fbfbfe",
      popup: "#312f33",
      popup_text: "#fbfbfe",
      sidebar: "#252428",
      sidebar_text: "#fbfbfe",
      tab_text: "#fbfbfe"
    },
    selectedTab: {
      blue: "#23327b",
      cyan: "#034554",
      green: "#004933",
      orange: "#701c07",
      pink: "#5f1854",
      purple: "#4f216b",
      red: "#69172d",
      yellow: "#5f3100",
      grey: "#515054"
    }
  }
};

const DEFAULT_COOKIE_STORE_ID = "firefox-default";

const darkSchemeQuery = window.matchMedia(
  "(prefers-color-scheme: dark)"
);

async function getContainerColor(cookieStoreId) {
  if (
    !cookieStoreId ||
    cookieStoreId === DEFAULT_COOKIE_STORE_ID
  ) {
    return null;
  }

  try {
    const identity =
      await browser.contextualIdentities.get(
        cookieStoreId
      );

    return identity.colorCode;
  } catch {
    // Private windows and disabled containers have no identity.
    return null;
  }
}

async function updateWindowTheme(windowId) {
  const { selectedTabTheme = false } =
    await browser.storage.local.get(
      "selectedTabTheme"
    );

  const [activeTab] =
    await browser.tabs.query({
      windowId,
      active: true
    });

  if (
    selectedTabTheme !== true ||
    !activeTab ||
    activeTab.groupId == null ||
    activeTab.groupId === UNGROUPED_ID
  ) {
    await browser.theme.reset(windowId);
    return;
  }

  const [group, containerColor] =
    await Promise.all([
      browser.tabGroups.get(
        activeTab.groupId
      ),
      getContainerColor(
        activeTab.cookieStoreId
      )
    ]);

  const palette =
    THEME_PALETTES[
      darkSchemeQuery.matches
        ? "dark"
        : "light"
    ];

  const colors = {
    ...palette.colors,
    tab_selected:
      palette.selectedTab[
        normalizeColor(group.color, "grey")
      ]
  };

  if (containerColor) {
    colors.tab_line = containerColor;
  }

  // A fixed scheme here would write itself into the global
  // browser.theme.*-theme prefs that darkSchemeQuery reads back.
  await browser.theme.update(windowId, {
    colors,
    properties: {
      color_scheme: "system",
      content_color_scheme: "system"
    }
  });
}

// Queued with the rule operations so that the last event, not the slowest
// round trip, decides the window's theme.
function refreshWindowTheme(windowId) {
  if (windowId == null) {
    return;
  }

  enqueueWindowOperation(
    windowId,
    () => updateWindowTheme(windowId)
  ).catch(error => {
    console.warn(
      `Could not update theme of window ${windowId}:`,
      error
    );
  });
}

browser.tabs.onActivated.addListener(
  ({ windowId }) => {
    refreshWindowTheme(windowId);
  }
);

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    if (tab.active) {
      refreshWindowTheme(tab.windowId);
    }
  },
  { properties: ["groupId"] }
);

browser.tabGroups.onUpdated.addListener(
  group => {
    refreshWindowTheme(group.windowId);
  }
);

async function refreshAllWindowThemes() {
  const windows =
    await browser.windows.getAll();

  for (const { id } of windows) {
    refreshWindowTheme(id);
  }
}

function logThemeRefreshError(error) {
  console.warn(
    "Could not refresh window themes:",
    error
  );
}

// Installing a global theme drops every window override. Window-scoped updates,
// including this extension's own, carry a windowId and are skipped.
browser.theme.onUpdated.addListener(
  ({ windowId }) => {
    if (windowId == null) {
      refreshAllWindowThemes().catch(
        logThemeRefreshError
      );
    }
  }
);

darkSchemeQuery.addEventListener(
  "change",
  () => {
    refreshAllWindowThemes().catch(
      logThemeRefreshError
    );
  }
);

browser.storage.onChanged.addListener(
  (changes, areaName) => {
    if (
      areaName === "local" &&
      "selectedTabTheme" in changes
    ) {
      refreshAllWindowThemes().catch(
        logThemeRefreshError
      );
    }
  }
);

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

async function initialize() {
  await migrateStorage();

  await applyRulesToAllTabs();

  await refreshAllWindowThemes();

  console.log(
    "Advanced Tab Manager background initialized"
  );
}

initialize().catch(error => {
  console.error(
    "Advanced Tab Manager initialization failed:",
    error
  );
});
