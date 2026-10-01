var SYNC_BACKUP_DEBOUNCE_MS = 2000;

var SYNC_BACKUP_SOURCE_KEYS = [
  "groups",
  "groupUnmatched",
  "groupSortMode",
  "groupColorMode",
  "selectedTabTheme"
];

const SYNC_BACKUP_OS_NAMES = {
  mac: "macOS",
  win: "Windows",
  linux: "Linux",
  android: "Android"
};

var syncBackupTimer = null;
var syncBackupRunning = false;
var syncBackupDirty = false;

function scheduleSyncBackup() {
  clearTimeout(syncBackupTimer);

  syncBackupTimer =
    setTimeout(
      requestSyncBackup,
      SYNC_BACKUP_DEBOUNCE_MS
    );
}

async function requestSyncBackup() {
  syncBackupTimer = null;

  if (syncBackupRunning) {
    syncBackupDirty = true;
    return;
  }

  syncBackupRunning = true;

  try {
    do {
      syncBackupDirty = false;
      await runSyncBackup();
    } while (syncBackupDirty);
  } finally {
    syncBackupRunning = false;
  }
}

async function updateSyncBackupStatus(
  changes
) {
  const { syncBackupStatus } =
    await browser.storage.local.get(
      "syncBackupStatus"
    );

  await browser.storage.local.set({
    syncBackupStatus: {
      lastWrittenAt: null,
      error: null,
      ...syncBackupStatus,
      ...changes
    }
  });
}

async function syncBackupLabel(
  createdAt
) {
  const { os } =
    await browser.runtime.getPlatformInfo();

  return (
    (SYNC_BACKUP_OS_NAMES[os] ?? os) +
    " " +
    createdAt.slice(0, 10)
  );
}

async function runSyncBackup() {
  try {
    await writeSyncBackup();
  } catch (error) {
    await updateSyncBackupStatus({
      error: error.message
    });
  }
}

async function writeSyncBackup() {
  const local =
    await browser.storage.local.get([
      ...SYNC_BACKUP_SOURCE_KEYS,
      "syncBackupEnabled",
      "syncBackupDeviceId",
      "syncBackupStatus"
    ]);

  const enabled =
    local.syncBackupEnabled === true;

  let deviceId =
    local.syncBackupDeviceId;

  if (!enabled && !deviceId) {
    return;
  }

  if (!deviceId) {
    deviceId =
      crypto.randomUUID();

    await browser.storage.local.set({
      syncBackupDeviceId: deviceId
    });
  }

  const metaKey =
    syncBackupMetaKey(deviceId);

  if (!enabled) {
    const { [metaKey]: stopped } =
      await browser.storage.sync.get(
        metaKey
      );

    if (stopped?.active) {
      await browser.storage.sync.set({
        [metaKey]: {
          ...stopped,
          active: false
        }
      });
    }

    return;
  }

  const now =
    new Date().toISOString();

  const backup =
    buildBackupObject(
      normalizeCreatedOrders(
        local.groups ?? []
      ).groups,
      local,
      now
    );

  const hash =
    await contentHash(backup);

  const synced =
    await browser.storage.sync.get(
      null
    );

  const existing =
    synced[metaKey];

  if (
    existing?.hash === hash &&
    existing.active
  ) {
    if (local.syncBackupStatus?.error) {
      await updateSyncBackupStatus({
        error: null
      });
    }

    return;
  }

  const createdAt =
    existing?.createdAt ?? now;

  const slot =
    await encodeSlot(
      deviceId,
      backup,
      {
        label:
          existing?.label ??
          (await syncBackupLabel(
            createdAt
          )),
        createdAt,
        active: true
      }
    );

  await browser.storage.sync.set(
    slot.items
  );

  const stale =
    slotKeys(synced, deviceId)
      .filter(
        key =>
          !slot.keys.includes(key)
      );

  if (stale.length > 0) {
    await browser.storage.sync.remove(
      stale
    );
  }

  await updateSyncBackupStatus({
    lastWrittenAt: now,
    error: null
  });
}

browser.storage.onChanged.addListener(
  (changes, areaName) => {
    if (
      areaName === "local" &&
      [
        "syncBackupEnabled",
        ...SYNC_BACKUP_SOURCE_KEYS
      ].some(key => key in changes)
    ) {
      scheduleSyncBackup();
    }
  }
);

browser.storage.local
  .get("syncBackupEnabled")
  .then(({ syncBackupEnabled }) => {
    if (syncBackupEnabled === true) {
      scheduleSyncBackup();
    }
  });
