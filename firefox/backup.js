const EXPORT_SCHEMA =
  "advanced-tab-manager";

// Backups written before the extension was renamed from Auto Group Tabs.
const LEGACY_EXPORT_SCHEMAS =
  new Set([
    "auto-group-tabs"
  ]);

const EXPORT_VERSION = 2;

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

function buildBackupObject(
  groups,
  settings,
  exportedAt
) {
  const {
    groupUnmatched = true,
    groupSortMode,
    groupColorMode,
    selectedTabTheme
  } =
    settings;

  return {
    schema:
      EXPORT_SCHEMA,

    version:
      EXPORT_VERSION,

    exportedAt,

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
      groups.map(
        (rule, index) =>
          validateAndNormalizeRule(
            rule,
            index
          )
      )
  };
}

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

// Limits of Firefox's storage.sync; the e2e limit checks pin them against the real component.
var SYNC_QUOTA_BYTES = 102400;
var SYNC_QUOTA_BYTES_PER_ITEM = 8192;
var SYNC_MAX_ITEMS = 512;
var SYNC_BACKUP_CHUNK_MARGIN_BYTES = 64;
var SYNC_BACKUP_CHUNK_BUDGET_BYTES =
  SYNC_QUOTA_BYTES_PER_ITEM -
  SYNC_BACKUP_CHUNK_MARGIN_BYTES;
var SYNC_BACKUP_KEY_PREFIX = "atm-backup:";

const SYNC_BACKUP_FORMAT = 1;

function syncBackupMetaKey(
  deviceId
) {
  return (
    SYNC_BACKUP_KEY_PREFIX +
    deviceId +
    ":meta"
  );
}

function syncBackupChunkKey(
  deviceId,
  index
) {
  return (
    SYNC_BACKUP_KEY_PREFIX +
    deviceId +
    ":c" +
    index
  );
}

function syncBackupBytes(
  text
) {
  return new TextEncoder()
    .encode(text)
    .length;
}

async function contentHash(
  backupObject
) {
  const text =
    JSON.stringify({
      schema:
        backupObject.schema,
      version:
        backupObject.version,
      settings:
        backupObject.settings,
      groups:
        backupObject.groups
    });

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder()
        .encode(text)
    );

  return Array.from(
    new Uint8Array(digest),
    byte =>
      byte
        .toString(16)
        .padStart(2, "0")
  ).join("");
}

async function encodeSlot(
  deviceId,
  backupObject,
  meta
) {
  const chunks = [];
  let current = [];

  const fits = rules =>
    syncBackupBytes(
      syncBackupChunkKey(
        deviceId,
        chunks.length
      )
    ) +
    syncBackupBytes(
      JSON.stringify(rules)
    ) <=
    SYNC_BACKUP_CHUNK_BUDGET_BYTES;

  for (
    const [index, rule] of
    backupObject.groups.entries()
  ) {
    if (
      current.length > 0 &&
      fits([...current, rule])
    ) {
      current.push(rule);
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
      current = [];
    }

    if (!fits([rule])) {
      throw new Error(
        `Rule ${index + 1} is too large to store in Firefox Sync ` +
        `(${syncBackupBytes(JSON.stringify(rule))} bytes).`
      );
    }

    current = [rule];
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  const metaKey =
    syncBackupMetaKey(deviceId);

  const items = {
    [metaKey]: {
      format:
        SYNC_BACKUP_FORMAT,
      label:
        meta.label,
      createdAt:
        meta.createdAt,
      active:
        meta.active,
      chunkCount:
        chunks.length,
      ruleCount:
        backupObject.groups.length,
      hash:
        await contentHash(
          backupObject
        ),
      schema:
        backupObject.schema,
      version:
        backupObject.version,
      exportedAt:
        backupObject.exportedAt,
      settings:
        backupObject.settings
    }
  };

  chunks.forEach(
    (rules, index) => {
      items[
        syncBackupChunkKey(
          deviceId,
          index
        )
      ] = rules;
    }
  );

  return {
    items,
    keys:
      Object.keys(items)
  };
}

async function decodeSyncBackupSlot(
  allSyncItems,
  deviceId
) {
  const meta =
    allSyncItems[
      syncBackupMetaKey(
        deviceId
      )
    ] ?? null;

  const slot = status => ({
    deviceId,
    meta,
    status,
    backup: null
  });

  if (meta === null) {
    return slot("incomplete");
  }

  if (
    meta.format !==
    SYNC_BACKUP_FORMAT
  ) {
    return slot("unknown-format");
  }

  const groups = [];

  for (
    let index = 0;
    index < meta.chunkCount;
    index++
  ) {
    const chunk =
      allSyncItems[
        syncBackupChunkKey(
          deviceId,
          index
        )
      ];

    if (!Array.isArray(chunk)) {
      return slot("incomplete");
    }

    groups.push(...chunk);
  }

  const backup = {
    schema:
      meta.schema,
    version:
      meta.version,
    exportedAt:
      meta.exportedAt,
    settings:
      meta.settings,
    groups
  };

  if (
    (await contentHash(backup)) !==
    meta.hash
  ) {
    return slot("incomplete");
  }

  try {
    parseBackupPayload(backup);
  } catch {
    return slot("unknown-format");
  }

  return {
    ...slot("complete"),
    backup
  };
}

async function listSlots(
  allSyncItems
) {
  const deviceIds = new Set();

  for (const key of Object.keys(allSyncItems)) {
    if (!key.startsWith(SYNC_BACKUP_KEY_PREFIX)) {
      continue;
    }

    const rest =
      key.slice(SYNC_BACKUP_KEY_PREFIX.length);

    const colon =
      rest.indexOf(":");

    if (colon > 0) {
      deviceIds.add(
        rest.slice(0, colon)
      );
    }
  }

  const slots = [];

  for (const deviceId of deviceIds) {
    slots.push(
      await decodeSyncBackupSlot(
        allSyncItems,
        deviceId
      )
    );
  }

  return slots;
}

function slotKeys(
  allSyncItems,
  deviceId
) {
  const own =
    SYNC_BACKUP_KEY_PREFIX +
    deviceId +
    ":";

  return Object.keys(allSyncItems)
    .filter(key => key.startsWith(own));
}
