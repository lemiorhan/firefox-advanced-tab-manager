// Advanced Tab Manager - Options page

const EXPORT_SCHEMA =
  "advanced-tab-manager";

// Backups written before the extension was renamed from Auto Group Tabs.
const LEGACY_EXPORT_SCHEMAS =
  new Set([
    "auto-group-tabs"
  ]);

const EXPORT_VERSION = 2;

const MAX_IMPORT_FILE_SIZE =
  1024 * 1024;

const STORAGE_COLORS =
  new Set([
    "blue",
    "yellow",
    "red",
    "green",
    "purple",
    "orange",
    "pink",
    "cyan",
    "gray"
  ]);

// -----------------------------------------------------------------------------
// Rule form
// -----------------------------------------------------------------------------

document
  .getElementById(
    "groupForm"
  )
  .addEventListener(
    "submit",
    event => {
      handleFormSubmit(
        event,
        "groupList"
      );
    }
  );

document
  .getElementById(
    "cancelBtn"
  )
  .addEventListener(
    "click",
    cancelEdit
  );

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

async function loadSettings() {
  const {
    groupUnmatched = true,
    groupSortMode = "alphabetical",
    groupColorMode = "assigned",
    selectedTabTheme = false
  } =
    await browser.storage.local.get([
      "groupUnmatched",
      "groupSortMode",
      "groupColorMode",
      "selectedTabTheme"
    ]);

  document.getElementById(
    "groupUnmatched"
  ).checked =
    groupUnmatched;

  document.getElementById(
    "groupSortMode"
  ).value =
    groupSortMode ===
    "creation"
      ? "creation"
      : "alphabetical";

  document.getElementById(
    "groupColorMode"
  ).value =
    groupColorMode ===
    "random"
      ? "random"
      : "assigned";

  document.getElementById(
    "selectedTabTheme"
  ).checked =
    selectedTabTheme === true;
}

document
  .getElementById(
    "selectedTabTheme"
  )
  .addEventListener(
    "change",
    async event => {
      await browser.storage.local.set({
        selectedTabTheme:
          event.target.checked
      });
    }
  );

document
  .getElementById(
    "groupColorMode"
  )
  .addEventListener(
    "change",
    async event => {
      const groupColorMode =
        event.target.value ===
        "random"
          ? "random"
          : "assigned";

      await browser.storage.local.set({
        groupColorMode
      });

      await applyRules();
    }
  );

document
  .getElementById(
    "groupUnmatched"
  )
  .addEventListener(
    "change",
    async event => {
      const groupUnmatched =
        event.target.checked;

      await browser.storage.local.set({
        groupUnmatched
      });

      await applyRules();
    }
  );

document
  .getElementById(
    "groupSortMode"
  )
  .addEventListener(
    "change",
    async event => {
      const groupSortMode =
        event.target.value ===
        "creation"
          ? "creation"
          : "alphabetical";

      await browser.storage.local.set({
        groupSortMode
      });

      await refreshList(
        "groupList"
      );

      try {
        await browser.runtime.sendMessage({
          action:
            "sortAllGroups"
        });
      } catch (error) {
        console.error(
          "Could not sort groups:",
          error
        );

        showStatus(
          "The setting was saved, but open groups could not be reordered.",
          "error"
        );
      }
    }
  );

// -----------------------------------------------------------------------------
// Status UI
// -----------------------------------------------------------------------------

function showStatus(
  message,
  type = "info"
) {
  const element =
    document.getElementById(
      "backupStatus"
    );

  element.textContent =
    message;

  element.className =
    `status ${type}`;
}

function clearStatus() {
  const element =
    document.getElementById(
      "backupStatus"
    );

  element.textContent = "";
  element.className =
    "status";
}

// -----------------------------------------------------------------------------
// Import / export validation
// -----------------------------------------------------------------------------

function normalizeStorageColor(
  color
) {
  if (
    typeof color !==
    "string"
  ) {
    return "blue";
  }

  let normalized =
    color
      .trim()
      .toLowerCase();

  if (
    normalized === "grey"
  ) {
    normalized = "gray";
  }

  return STORAGE_COLORS.has(
    normalized
  )
    ? normalized
    : "blue";
}

function validateAndNormalizeRule(
  rule,
  index
) {
  if (
    !rule ||
    typeof rule !== "object" ||
    Array.isArray(rule)
  ) {
    throw new Error(
      `Rule ${index + 1} is not a valid object.`
    );
  }

  if (
    typeof rule.name !==
      "string" ||
    !rule.name.trim()
  ) {
    throw new Error(
      `Rule ${index + 1} has no group name.`
    );
  }

  if (
    typeof rule.pattern !==
      "string" ||
    !rule.pattern.trim()
  ) {
    throw new Error(
      `Rule "${rule.name}" has no URL pattern.`
    );
  }

  const result = {
    name:
      rule.name.trim(),

    pattern:
      rule.pattern.trim(),

    color:
      normalizeStorageColor(
        rule.color
      )
  };

  if (
    Number.isInteger(
      rule.createdOrder
    ) &&
    rule.createdOrder > 0
  ) {
    result.createdOrder =
      rule.createdOrder;
  }

  return result;
}

function validateRuleNames(
  groups
) {
  const seen =
    new Set();

  for (
    const rule of groups
  ) {
    const key =
      rule.name
        .trim()
        .toLowerCase();

    if (seen.has(key)) {
      throw new Error(
        `The import contains more than one rule named "${rule.name}".`
      );
    }

    seen.add(key);
  }
}

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

async function exportRules() {
  clearStatus();

  try {
    const groups =
      await getGroupsWithCreatedOrder();

    const {
      groupUnmatched = true,
      groupSortMode = "alphabetical",
      groupColorMode = "assigned",
      selectedTabTheme = false
    } =
      await browser.storage.local.get([
        "groupUnmatched",
        "groupSortMode",
        "groupColorMode",
        "selectedTabTheme"
      ]);

    const normalizedGroups =
      groups.map(
        (rule, index) =>
          validateAndNormalizeRule(
            rule,
            index
          )
      );

    const backup = {
      schema:
        EXPORT_SCHEMA,

      version:
        EXPORT_VERSION,

      exportedAt:
        new Date()
          .toISOString(),

      settings: {
        groupUnmatched,

        groupSortMode:
          groupSortMode ===
          "creation"
            ? "creation"
            : "alphabetical",

        groupColorMode:
          groupColorMode ===
          "random"
            ? "random"
            : "assigned",

        selectedTabTheme:
          selectedTabTheme === true
      },

      groups:
        normalizedGroups
    };

    const json =
      JSON.stringify(
        backup,
        null,
        2
      );

    const blob =
      new Blob(
        [json],
        {
          type:
            "application/json"
        }
      );

    const objectUrl =
      URL.createObjectURL(
        blob
      );

    const timestamp =
      new Date()
        .toISOString()
        .replace(
          /[:.]/g,
          "-"
        );

    const filename =
      `advanced-tab-manager-rules-${timestamp}.json`;

    const anchor =
      document.createElement(
        "a"
      );

    anchor.href =
      objectUrl;

    anchor.download =
      filename;

    document.body.appendChild(
      anchor
    );

    anchor.click();
    anchor.remove();

    setTimeout(
      () => {
        URL.revokeObjectURL(
          objectUrl
        );
      },
      1000
    );

    showStatus(
      `Exported ${normalizedGroups.length} rule(s).`,
      "success"
    );
  } catch (error) {
    console.error(
      "Export failed:",
      error
    );

    showStatus(
      `Export failed: ${error.message}`,
      "error"
    );
  }
}

// -----------------------------------------------------------------------------
// Backup parser
// -----------------------------------------------------------------------------

function parseBackupPayload(
  data
) {
  let rawGroups;

  let importedGroupUnmatched;

  let importedGroupSortMode;
  let importedGroupColorMode;
  let importedSelectedTabTheme;

  // Raw array compatibility.
  if (Array.isArray(data)) {
    rawGroups = data;
  } else if (
    data &&
    typeof data === "object"
  ) {
    if (
      data.schema &&
      data.schema !==
        EXPORT_SCHEMA &&
      !LEGACY_EXPORT_SCHEMAS.has(
        data.schema
      )
    ) {
      throw new Error(
        `Unsupported backup schema: ${data.schema}`
      );
    }

    if (
      data.version != null &&
      data.version >
        EXPORT_VERSION
    ) {
      throw new Error(
        `This backup uses version ${data.version}. ` +
        `This extension supports up to version ${EXPORT_VERSION}.`
      );
    }

    rawGroups =
      data.groups;

    if (
      data.settings &&
      typeof data.settings
        .groupUnmatched ===
        "boolean"
    ) {
      importedGroupUnmatched =
        data.settings
          .groupUnmatched;
    } else if (
      typeof data.groupUnmatched ===
      "boolean"
    ) {
      importedGroupUnmatched =
        data.groupUnmatched;
    }

    const sortMode =
      data.settings
        ?.groupSortMode ??
      data.groupSortMode;

    if (
      sortMode ===
        "creation" ||
      sortMode ===
        "alphabetical"
    ) {
      importedGroupSortMode =
        sortMode;
    }

    const colorMode =
      data.settings
        ?.groupColorMode ??
      data.groupColorMode;

    if (
      colorMode ===
        "assigned" ||
      colorMode ===
        "random"
    ) {
      importedGroupColorMode =
        colorMode;
    }

    const selectedTabTheme =
      data.settings
        ?.selectedTabTheme ??
      data.selectedTabTheme;

    if (
      typeof selectedTabTheme ===
      "boolean"
    ) {
      importedSelectedTabTheme =
        selectedTabTheme;
    }
  }

  if (
    !Array.isArray(
      rawGroups
    )
  ) {
    throw new Error(
      'The backup does not contain a valid "groups" array.'
    );
  }

  const groups =
    rawGroups.map(
      (rule, index) =>
        validateAndNormalizeRule(
          rule,
          index
        )
    );

  validateRuleNames(
    groups
  );

  return {
    groups,
    groupUnmatched:
      importedGroupUnmatched,
    groupSortMode:
      importedGroupSortMode,
    groupColorMode:
      importedGroupColorMode,
    selectedTabTheme:
      importedSelectedTabTheme
  };
}

// -----------------------------------------------------------------------------
// Merge
// -----------------------------------------------------------------------------

function mergeGroups(
  existingGroups,
  importedGroups
) {
  const existingNormalized =
    normalizeCreatedOrders(
      existingGroups.map(
        (rule, index) =>
          validateAndNormalizeRule(
            rule,
            index
          )
      )
    ).groups;

  const result =
    existingNormalized.map(
      rule => ({
        ...rule
      })
    );

  const indexByName =
    new Map();

  result.forEach(
    (rule, index) => {
      indexByName.set(
        rule.name
          .toLowerCase(),
        index
      );
    }
  );

  let nextCreatedOrder =
    getNextCreatedOrder(
      result
    );

  for (
    const importedRule of
    importedGroups
  ) {
    const key =
      importedRule.name
        .toLowerCase();

    const existingIndex =
      indexByName.get(key);

    if (
      existingIndex != null
    ) {
      // For merge, preserve local creation position.
      result[existingIndex] = {
        ...importedRule,
        createdOrder:
          result[existingIndex]
            .createdOrder
      };
    } else {
      result.push({
        ...importedRule,
        createdOrder:
          nextCreatedOrder++
      });

      indexByName.set(
        key,
        result.length - 1
      );
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// Import
// -----------------------------------------------------------------------------

function getImportMode() {
  return (
    document.querySelector(
      'input[name="importMode"]:checked'
    )?.value ||
    "replace"
  );
}

async function importRules(
  file
) {
  clearStatus();

  if (!file) {
    return;
  }

  if (
    file.size >
    MAX_IMPORT_FILE_SIZE
  ) {
    showStatus(
      "Import failed: the selected file is larger than 1 MB.",
      "error"
    );

    return;
  }

  try {
    const text =
      await file.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      throw new Error(
        "The selected file is not valid JSON."
      );
    }

    const imported =
      parseBackupPayload(
        data
      );

    const mode =
      getImportMode();

    let finalGroups;

    if (
      mode === "merge"
    ) {
      const existingGroups =
        await getGroupsWithCreatedOrder();

      finalGroups =
        mergeGroups(
          existingGroups,
          imported.groups
        );
    } else {
      finalGroups =
        normalizeCreatedOrders(
          imported.groups
        ).groups;
    }

    const storageUpdate = {
      groups:
        finalGroups
    };

    if (
      typeof imported
        .groupUnmatched ===
      "boolean"
    ) {
      storageUpdate.groupUnmatched =
        imported.groupUnmatched;
    }

    if (
      imported.groupSortMode ===
        "creation" ||
      imported.groupSortMode ===
        "alphabetical"
    ) {
      storageUpdate.groupSortMode =
        imported.groupSortMode;
    }

    if (
      imported.groupColorMode ===
        "assigned" ||
      imported.groupColorMode ===
        "random"
    ) {
      storageUpdate.groupColorMode =
        imported.groupColorMode;
    }

    if (
      typeof imported
        .selectedTabTheme ===
      "boolean"
    ) {
      storageUpdate.selectedTabTheme =
        imported.selectedTabTheme;
    }

    await browser.storage.local.set(
      storageUpdate
    );

    // Never restore old transient group IDs.
    await browser.storage.local.remove(
      "groupMap"
    );

    await loadSettings();

    await refreshList(
      "groupList"
    );

    const applied =
      await applyRules();

    if (!applied) {
      return;
    }

    if (
      mode === "merge"
    ) {
      showStatus(
        `Import complete. ${imported.groups.length} rule(s) imported, ` +
          `${finalGroups.length} rule(s) now configured.`,
        "success"
      );
    } else {
      showStatus(
        `Import complete. ${finalGroups.length} rule(s) restored.`,
        "success"
      );
    }
  } catch (error) {
    console.error(
      "Import failed:",
      error
    );

    showStatus(
      `Import failed: ${error.message}`,
      "error"
    );
  }
}

// -----------------------------------------------------------------------------
// Apply rules
// -----------------------------------------------------------------------------

async function applyRules() {
  try {
    const response =
      await browser.runtime.sendMessage({
        action:
          "applyRulesToAllTabs"
      });

    if (
      response?.success === false
    ) {
      throw new Error(
        response.error ||
          "Unknown background error"
      );
    }

    return true;
  } catch (error) {
    console.error(
      "Rules saved but tabs could not be reorganized:",
      error
    );

    showStatus(
      "Rules were saved, but existing tabs could not be reorganized. " +
        "Reload the extension and try again.",
      "error"
    );

    return false;
  }
}

// -----------------------------------------------------------------------------
// Backup buttons
// -----------------------------------------------------------------------------

document
  .getElementById(
    "exportRules"
  )
  .addEventListener(
    "click",
    exportRules
  );

document
  .getElementById(
    "importRules"
  )
  .addEventListener(
    "click",
    () => {
      clearStatus();

      document
        .getElementById(
          "importFile"
        )
        .click();
    }
  );

document
  .getElementById(
    "importFile"
  )
  .addEventListener(
    "change",
    async event => {
      const file =
        event.target
          .files?.[0];

      await importRules(
        file
      );

      // Allow selecting the same file again.
      event.target.value = "";
    }
  );

// -----------------------------------------------------------------------------
// Initial load
// -----------------------------------------------------------------------------

loadSettings();
refreshList("groupList");
