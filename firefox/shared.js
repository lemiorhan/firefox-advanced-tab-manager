// Shared utilities and constants

const colorMap = {
  blue: "#4A90E2",
  yellow: "#F5A623",
  red: "#D0021B",
  green: "#7ED321",
  purple: "#9013FE",
  orange: "#F5A623",
  pink: "#F78DA7",
  cyan: "#50E3C2",
  gray: "#9B9B9B"
};

const availableColors = [
  "blue",
  "yellow",
  "red",
  "green",
  "purple",
  "orange",
  "pink",
  "cyan",
  "gray"
];

let editingIndex = null;

// -----------------------------------------------------------------------------
// Creation-order metadata
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

async function getGroupsWithCreatedOrder() {
  const {
    groups = []
  } =
    await browser.storage.local.get(
      "groups"
    );

  const normalized =
    normalizeCreatedOrders(
      Array.isArray(groups)
        ? groups
        : []
    );

  if (normalized.changed) {
    await browser.storage.local.set({
      groups: normalized.groups
    });
  }

  return normalized.groups;
}

function getNextCreatedOrder(
  groups
) {
  return (
    groups.reduce(
      (max, group) =>
        Math.max(
          max,
          Number.isInteger(
            group.createdOrder
          )
            ? group.createdOrder
            : 0
        ),
      0
    ) + 1
  );
}

// -----------------------------------------------------------------------------
// Display sorting
// -----------------------------------------------------------------------------

function compareRuleNames(
  a,
  b
) {
  return String(a || "").localeCompare(
    String(b || ""),
    undefined,
    {
      sensitivity: "base",
      numeric: true
    }
  );
}

async function getDisplayEntries(
  groups
) {
  const {
    groupSortMode = "alphabetical"
  } =
    await browser.storage.local.get(
      "groupSortMode"
    );

  const entries =
    groups.map(
      (rule, storageIndex) => ({
        rule,
        storageIndex
      })
    );

  if (
    groupSortMode !==
    "creation"
  ) {
    entries.sort(
      (a, b) =>
        compareRuleNames(
          a.rule.name,
          b.rule.name
        )
    );
  } else {
    entries.sort(
      (a, b) => {
        const aOrder =
          a.rule.createdOrder ??
          a.storageIndex;

        const bOrder =
          b.rule.createdOrder ??
          b.storageIndex;

        return (
          aOrder - bOrder
        );
      }
    );
  }

  return entries;
}

// -----------------------------------------------------------------------------
// Color helper
// -----------------------------------------------------------------------------

async function selectUnusedColor() {
  const groups =
    await getGroupsWithCreatedOrder();

  const usedColors =
    groups.map(
      group => group.color
    );

  const unusedColor =
    availableColors.find(
      color =>
        !usedColors.includes(
          color
        )
    );

  const colorSelect =
    document.getElementById(
      "color"
    );

  if (
    unusedColor &&
    colorSelect
  ) {
    colorSelect.value =
      unusedColor;
  }
}

// -----------------------------------------------------------------------------
// Rule list
// -----------------------------------------------------------------------------

async function refreshList(
  listElementId
) {
  const groups =
    await getGroupsWithCreatedOrder();

  const list =
    document.getElementById(
      listElementId
    );

  if (!list) {
    return;
  }

  list.innerHTML = "";

  if (
    groups.length === 0
  ) {
    const emptyDiv =
      document.createElement(
        "div"
      );

    emptyDiv.className =
      "empty-message";

    emptyDiv.textContent =
      "No rules configured yet" +
      (
        listElementId ===
        "groupList"
          ? ". Add one below!"
          : ""
      );

    list.appendChild(
      emptyDiv
    );

    return;
  }

  // A reorderable list shows match priority, so it ignores the sort mode.
  const reorderable =
    list.hasAttribute(
      "data-reorderable"
    );

  const entries =
    reorderable
      ? groups.map(
          (rule, storageIndex) => ({
            rule,
            storageIndex
          })
        )
      : await getDisplayEntries(
          groups
        );

  for (
    const entry of entries
  ) {
    const {
      rule: group,
      storageIndex
    } = entry;

    const li =
      document.createElement(
        "li"
      );

    const colorIndicator =
      document.createElement(
        "span"
      );

    colorIndicator.className =
      "color-indicator";

    colorIndicator.style.backgroundColor =
      colorMap[group.color] ||
      colorMap.blue;

    const infoDiv =
      document.createElement(
        "div"
      );

    infoDiv.className =
      "group-info";

    const nameDiv =
      document.createElement(
        "div"
      );

    nameDiv.className =
      "group-name";

    nameDiv.appendChild(
      colorIndicator.cloneNode(
        true
      )
    );

    nameDiv.appendChild(
      document.createTextNode(
        group.name
      )
    );

    const patternDiv =
      document.createElement(
        "div"
      );

    patternDiv.className =
      "group-pattern";

    patternDiv.textContent =
      group.pattern;

    infoDiv.appendChild(
      nameDiv
    );

    infoDiv.appendChild(
      patternDiv
    );

    const buttonContainer =
      document.createElement(
        "div"
      );

    buttonContainer.style.display =
      "flex";

    buttonContainer.style.gap =
      "8px";

    const editBtn =
      document.createElement(
        "button"
      );

    editBtn.className =
      "edit-btn";

    editBtn.textContent = "✎";
    editBtn.title = "Edit rule";

    editBtn.onclick =
      () =>
        startEdit(
          storageIndex,
          group
        );

    const deleteBtn =
      document.createElement(
        "button"
      );

    deleteBtn.className =
      "delete-btn";

    deleteBtn.textContent = "✕";
    deleteBtn.title =
      "Delete rule";

    deleteBtn.onclick =
      () =>
        deleteRule(
          storageIndex,
          group.name,
          listElementId
        );

    if (reorderable) {
      const moveUpBtn =
        document.createElement(
          "button"
        );

      moveUpBtn.className =
        "move-btn";

      moveUpBtn.textContent = "↑";
      moveUpBtn.title =
        "Move rule up";

      moveUpBtn.disabled =
        storageIndex === 0;

      moveUpBtn.onclick =
        () =>
          moveRule(
            storageIndex,
            -1,
            listElementId
          );

      const moveDownBtn =
        document.createElement(
          "button"
        );

      moveDownBtn.className =
        "move-btn";

      moveDownBtn.textContent = "↓";
      moveDownBtn.title =
        "Move rule down";

      moveDownBtn.disabled =
        storageIndex ===
        groups.length - 1;

      moveDownBtn.onclick =
        () =>
          moveRule(
            storageIndex,
            1,
            listElementId
          );

      buttonContainer.appendChild(
        moveUpBtn
      );

      buttonContainer.appendChild(
        moveDownBtn
      );
    }

    buttonContainer.appendChild(
      editBtn
    );

    buttonContainer.appendChild(
      deleteBtn
    );

    li.appendChild(
      infoDiv
    );

    li.appendChild(
      buttonContainer
    );

    list.appendChild(li);
  }

  if (
    editingIndex === null
  ) {
    selectUnusedColor();
  }
}

// -----------------------------------------------------------------------------
// Edit / delete
// -----------------------------------------------------------------------------

function startEdit(
  index,
  rule
) {
  editingIndex =
    index;

  document.getElementById(
    "name"
  ).value = rule.name;

  document.getElementById(
    "pattern"
  ).value = rule.pattern;

  document.getElementById(
    "color"
  ).value = rule.color;

  document.getElementById(
    "submitBtn"
  ).textContent =
    "Update Rule";

  document.getElementById(
    "cancelBtn"
  ).style.display =
    "inline-block";

  document.getElementById(
    "name"
  ).focus();

  const formTitle =
    document.getElementById(
      "groupFormTitle"
    );

  if (formTitle) {
    formTitle.textContent =
      "Edit Rule";

    const sections =
      document.querySelectorAll(
        ".section"
      );

    const lastSection =
      sections[
        sections.length - 1
      ];

    lastSection?.scrollIntoView({
      behavior: "smooth"
    });
  }
}

async function deleteRule(
  index,
  name,
  listElementId
) {
  const shouldDelete =
    window.confirm
      ? confirm(
          `Delete rule "${name}"?`
        )
      : true;

  if (!shouldDelete) {
    return;
  }

  const groups =
    await getGroupsWithCreatedOrder();

  groups.splice(
    index,
    1
  );

  await browser.storage.local.set({
    groups
  });

  if (
    editingIndex === index
  ) {
    cancelEdit();
  } else if (
    editingIndex !== null &&
    editingIndex > index
  ) {
    editingIndex--;
  }

  try {
    await browser.runtime.sendMessage({
      action:
        "applyRulesToAllTabs"
    });
  } catch (error) {
    console.error(
      "Could not reapply rules after deletion:",
      error
    );
  }

  await refreshList(
    listElementId
  );
}

async function moveRule(
  index,
  offset,
  listElementId
) {
  const groups =
    await getGroupsWithCreatedOrder();

  const target =
    index + offset;

  // The list may be stale if the popup changed the rules meanwhile.
  if (
    target < 0 ||
    target >= groups.length
  ) {
    await refreshList(
      listElementId
    );

    return;
  }

  [
    groups[index],
    groups[target]
  ] = [
    groups[target],
    groups[index]
  ];

  await browser.storage.local.set({
    groups
  });

  if (
    editingIndex === index
  ) {
    editingIndex = target;
  } else if (
    editingIndex === target
  ) {
    editingIndex = index;
  }

  try {
    await browser.runtime.sendMessage({
      action:
        "applyRulesToAllTabs"
    });
  } catch (error) {
    console.error(
      "Could not reapply rules after reordering:",
      error
    );
  }

  await refreshList(
    listElementId
  );
}

function cancelEdit() {
  editingIndex = null;

  const form =
    document.getElementById(
      "groupForm"
    );

  form?.reset();

  const submitBtn =
    document.getElementById(
      "submitBtn"
    );

  if (submitBtn) {
    submitBtn.textContent =
      "Add Rule";
  }

  const cancelBtn =
    document.getElementById(
      "cancelBtn"
    );

  if (cancelBtn) {
    cancelBtn.style.display =
      "none";
  }

  const formTitle =
    document.getElementById(
      "groupFormTitle"
    );

  if (formTitle) {
    formTitle.textContent =
      "Add New Rule";
  }

  selectUnusedColor();
}

// -----------------------------------------------------------------------------
// Add / update rule
// -----------------------------------------------------------------------------

async function handleFormSubmit(
  event,
  listElementId
) {
  event.preventDefault();

  const name =
    document
      .getElementById("name")
      .value
      .trim();

  const pattern =
    document
      .getElementById("pattern")
      .value
      .trim();

  const color =
    document.getElementById(
      "color"
    ).value;

  if (
    !name ||
    !pattern
  ) {
    alert(
      "Please fill in both name and pattern"
    );

    return;
  }

  const groups =
    await getGroupsWithCreatedOrder();

  const duplicateIndex =
    groups.findIndex(
      group =>
        group.name
          .trim()
          .toLowerCase() ===
        name.toLowerCase()
    );

  if (
    duplicateIndex !== -1 &&
    duplicateIndex !==
      editingIndex
  ) {
    alert(
      `A rule named "${name}" already exists`
    );

    return;
  }

  if (
    editingIndex !== null
  ) {
    const oldRule =
      groups[editingIndex];

    if (!oldRule) {
      editingIndex = null;

      alert(
        "The rule could not be found. Please try again."
      );

      return;
    }

    groups[editingIndex] = {
      ...oldRule,
      name,
      pattern,
      color
    };
  } else {
    groups.push({
      name,
      pattern,
      color,
      createdOrder:
        getNextCreatedOrder(
          groups
        )
    });
  }

  await browser.storage.local.set({
    groups
  });

  try {
    await browser.runtime.sendMessage({
      action:
        "applyRulesToAllTabs"
    });
  } catch (error) {
    console.error(
      "Could not apply rules:",
      error
    );
  }

  editingIndex = null;

  event.target.reset();

  document.getElementById(
    "submitBtn"
  ).textContent =
    "Add Rule";

  document.getElementById(
    "cancelBtn"
  ).style.display =
    "none";

  const formTitle =
    document.getElementById(
      "groupFormTitle"
    );

  if (formTitle) {
    formTitle.textContent =
      "Add New Rule";
  }

  await refreshList(
    listElementId
  );
}
