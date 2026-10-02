// Advanced Tab Manager - Options page

const MAX_IMPORT_FILE_SIZE =
  1024 * 1024;

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
// Export
// -----------------------------------------------------------------------------

async function exportRules() {
  clearStatus();

  try {
    const groups =
      await getGroupsWithCreatedOrder();

    const settings =
      await browser.storage.local.get([
        "groupUnmatched",
        "groupSortMode",
        "groupColorMode",
        "selectedTabTheme"
      ]);

    const backup =
      buildBackupObject(
        groups,
        settings,
        new Date()
          .toISOString()
      );

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
      `Exported ${backup.groups.length} rule(s).`,
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

function showImportFailure(
  error
) {
  console.error(
    "Import failed:",
    error
  );

  showStatus(
    `Import failed: ${error.message}`,
    "error"
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

  let data;

  try {
    const text =
      await file.text();

    try {
      data =
        JSON.parse(text);
    } catch {
      throw new Error(
        "The selected file is not valid JSON."
      );
    }
  } catch (error) {
    showImportFailure(
      error
    );

    return;
  }

  await applyBackupPayload(
    data,
    getImportMode()
  );
}

async function applyBackupPayload(
  data,
  mode
) {
  try {
    const imported =
      parseBackupPayload(
        data
      );

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
    showImportFailure(
      error
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
// Automatic backup (Firefox Sync)
// -----------------------------------------------------------------------------

let syncBackupRefreshSeq = 0;

function formatSyncTime(iso) {
  return new Date(iso).toLocaleString();
}

function renderSyncBackupState(
  local,
  hasOwnSlot
) {
  const element =
    document.getElementById(
      "syncBackupState"
    );

  const status =
    local.syncBackupStatus;

  let message = "";
  let type = "";

  if (
    local.syncBackupEnabled === true
  ) {
    if (status?.error) {
      message =
        `Backup failed: ${status.error}`;
      type = "error";
    } else if (status?.lastWrittenAt) {
      message =
        "Saved in Firefox Sync storage at " +
        formatSyncTime(
          status.lastWrittenAt
        ) +
        ".";
      type = "success";
    } else {
      message =
        "Waiting for the first save to Firefox Sync storage.";
      type = "info";
    }
  } else if (hasOwnSlot) {
    message =
      "Automatic backup is off. The last copy stays in Firefox Sync until you delete it.";
    type = "info";
  }

  element.textContent = message;

  element.className =
    type ? `status ${type}` : "status";
}

function syncSlotDetail(slot) {
  const parts = [];

  if (slot.status === "complete") {
    parts.push(
      `${slot.meta.ruleCount} rule(s)`,
      `saved ${formatSyncTime(slot.meta.exportedAt)}`
    );
  } else if (slot.status === "incomplete") {
    parts.push(
      "incomplete: still syncing or damaged"
    );
  } else {
    parts.push(
      "unknown format: made by a different extension version"
    );
  }

  if (slot.meta?.active === false) {
    parts.push("stopped");
  }

  return parts.join(" · ");
}

function renderSyncSlots(
  slots,
  local
) {
  const list =
    document.getElementById(
      "syncSlotList"
    );

  list.textContent = "";

  for (const slot of slots) {
    const own =
      slot.deviceId ===
      local.syncBackupDeviceId;

    const item =
      document.createElement("li");

    item.dataset.deviceId =
      slot.deviceId;

    const info =
      document.createElement("div");

    const title =
      document.createElement("div");

    title.className = "group-name";

    title.textContent =
      (slot.meta?.label ?? "Unknown device") +
      (own ? " (this device)" : "");

    const detail =
      document.createElement("div");

    detail.className = "slot-detail";

    detail.textContent =
      syncSlotDetail(slot);

    info.append(title, detail);

    const actions =
      document.createElement("div");

    actions.className = "slot-actions";

    const restore =
      document.createElement("button");

    restore.type = "button";
    restore.className =
      "slot-btn slot-restore";
    restore.textContent = "Restore";
    restore.disabled =
      slot.status !== "complete";

    restore.addEventListener(
      "click",
      () => restoreSyncSlot(slot)
    );

    const remove =
      document.createElement("button");

    remove.type = "button";
    remove.className =
      "slot-btn slot-delete";
    remove.textContent = "Delete";
    remove.disabled =
      own &&
      local.syncBackupEnabled === true;

    remove.addEventListener(
      "click",
      () => deleteSyncSlot(slot)
    );

    actions.append(restore, remove);
    item.append(info, actions);
    list.append(item);
  }
}

async function refreshSyncBackup() {
  const seq =
    ++syncBackupRefreshSeq;

  let local;
  let slots;

  try {
    local =
      await browser.storage.local.get([
        "syncBackupEnabled",
        "syncBackupDeviceId",
        "syncBackupStatus"
      ]);

    slots =
      await listSlots(
        await browser.storage.sync.get(
          null
        )
      );
  } catch (error) {
    const element =
      document.getElementById(
        "syncBackupState"
      );

    element.textContent =
      `Firefox Sync storage could not be read: ${error.message}`;

    element.className =
      "status error";

    return;
  }

  if (seq !== syncBackupRefreshSeq) {
    return;
  }

  document.getElementById(
    "syncBackupEnabled"
  ).checked =
    local.syncBackupEnabled === true;

  renderSyncBackupState(
    local,
    slots.some(
      slot =>
        slot.deviceId ===
        local.syncBackupDeviceId
    )
  );

  renderSyncSlots(slots, local);
}

async function restoreSyncSlot(slot) {
  const mode =
    getImportMode();

  const modeText =
    mode === "merge"
      ? "Merge with the existing rules"
      : "Replace all rules";

  if (
    !confirm(
      `Restore the backup from "${slot.meta?.label ?? slot.deviceId}"?\n\n` +
        `Mode: ${modeText}.`
    )
  ) {
    return;
  }

  clearStatus();

  await applyBackupPayload(
    slot.backup,
    mode
  );

  document
    .getElementById("backupStatus")
    .scrollIntoView({
      block: "nearest"
    });
}

async function deleteSyncSlot(slot) {
  if (
    !confirm(
      `Delete the backup from "${slot.meta?.label ?? slot.deviceId}" in Firefox Sync?`
    )
  ) {
    return;
  }

  await browser.storage.sync.remove(
    slotKeys(
      await browser.storage.sync.get(
        null
      ),
      slot.deviceId
    )
  );
}

document
  .getElementById(
    "syncBackupEnabled"
  )
  .addEventListener(
    "change",
    async event => {
      const enabled =
        event.target.checked;

      await browser.storage.local.set({
        syncBackupEnabled: enabled
      });

      const offer =
        document.getElementById(
          "syncBackupOffer"
        );

      const list =
        document.getElementById(
          "syncSlotList"
        );

      offer.textContent = "";
      offer.className = "status";
      list.classList.remove("offered");

      if (!enabled) {
        return;
      }

      const { syncBackupDeviceId } =
        await browser.storage.local.get(
          "syncBackupDeviceId"
        );

      const slots =
        await listSlots(
          await browser.storage.sync.get(
            null
          )
        );

      if (
        slots.some(
          slot =>
            slot.deviceId !==
            syncBackupDeviceId
        )
      ) {
        offer.textContent =
          "Backups from other devices are already in Firefox Sync. Restore one from the list below.";

        offer.className =
          "status info";

        list.classList.add("offered");

        list.scrollIntoView({
          block: "nearest"
        });
      }
    }
  );

browser.storage.onChanged.addListener(
  (changes, areaName) => {
    if (
      areaName === "sync"
        ? Object.keys(changes).some(
            key =>
              key.startsWith(
                SYNC_BACKUP_KEY_PREFIX
              )
          )
        : areaName === "local" &&
          [
            "syncBackupStatus",
            "syncBackupEnabled",
            "syncBackupDeviceId"
          ].some(key => key in changes)
    ) {
      refreshSyncBackup();
    }
  }
);

// -----------------------------------------------------------------------------
// Initial load
// -----------------------------------------------------------------------------

loadSettings();
refreshList("groupList");
refreshSyncBackup();
