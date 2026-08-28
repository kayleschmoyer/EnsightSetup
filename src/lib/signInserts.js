import {
  buildDisplayControllerSheetRow,
  buildDisplayLevelSheetRows,
  formatSheetBoolUpper,
  displayGroupNameForDevice,
  garageSheetName,
  levelSheetInternalName,
  signDisplayName,
} from './configSheetSchema';

/** Create a new insert row for a multi-insert monument sign. */
export function createSignInsert(partial = {}) {
  // A real uuid — sign_inserts.id is a uuid primary key (see
  // 0009_device_field_normalization.sql), matching every other entity in the app.
  const id = partial.id || crypto.randomUUID();
  return {
    id,
    displayName: partial.displayName ?? '',
    serialAddress: partial.serialAddress ?? '',
    hasEthernet: !!partial.hasEthernet,
    displayLevelAll: !!partial.displayLevelAll,
    displayLevelIds: Array.isArray(partial.displayLevelIds) ? [...partial.displayLevelIds] : [],
  };
}

/** True when the device uses the inserts array (monument / multi-insert mode). */
export function signUsesInserts(device) {
  return Array.isArray(device?.inserts);
}

/**
 * Sheet DisplayName for one insert: freeform name if set, else map ID (e.g. S1.1).
 */
export function insertSheetDisplayName(device, insert) {
  const free = String(insert?.displayName || '').trim();
  if (free) return free;
  return signDisplayName(device);
}

/** All DisplayControllers / DisplayLevels keys owned by this sign device. */
export function allSignSheetDisplayNames(device) {
  if (signUsesInserts(device) && device.inserts.length > 0) {
    const names = device.inserts
      .map((insert) => insertSheetDisplayName(device, insert))
      .filter(Boolean);
    // Deduplicate while preserving order
    const seen = new Set();
    return names.filter((n) => {
      const key = n.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const name = signDisplayName(device);
  return name ? [name] : [];
}

/** Ensure only one insert has the ethernet flag. */
export function withEthernetOnInsert(inserts, insertId) {
  return (inserts || []).map((ins) => ({
    ...ins,
    hasEthernet: ins.id === insertId,
  }));
}

function buildControllerRowForInsert(device, insert, { displayGroups = [], servers = [] } = {}) {
  const displayName = insertSheetDisplayName(device, insert);
  const serverName = (() => {
    if (device?.server) return String(device.server);
    if (device?.serverId != null) {
      const match = servers.find((s) => s.id === device.serverId);
      return match?.name || '';
    }
    return '';
  })();
  const displayProtocol = device?.displayProtocol || '';
  return [
    displayName,
    device?.controllerName || displayName,
    device?.visibleName || displayName,
    displayGroupNameForDevice(device, displayGroups),
    serverName,
    device?.ipAddress || '',
    device?.port || '',
    insert?.serialAddress || '',
    displayProtocol,
    device?.displayMap || '',
    device?.hardwareType || '',
    formatSheetBoolUpper(device?.keepLevelCountsSeparate ?? false),
  ];
}

/**
 * One or more DisplayControllers rows for a sign.
 * Multi-insert monuments expand to one row per insert (shared controller/IP).
 */
export function buildDisplayControllerSheetRows(device, opts = {}) {
  if (signUsesInserts(device) && device.inserts.length > 0) {
    return device.inserts
      .map((insert) => {
        const name = insertSheetDisplayName(device, insert);
        if (!name) return null;
        return {
          key: name,
          row: buildControllerRowForInsert(device, insert, opts),
        };
      })
      .filter(Boolean);
  }
  const name = signDisplayName(device);
  if (!name) return [];
  return [{
    key: name,
    row: buildDisplayControllerSheetRow(device, opts),
  }];
}

function buildLevelRowsForInsert(device, insert, sites = []) {
  const displayName = insertSheetDisplayName(device, insert);
  if (!displayName || device?.displaySiteId == null) return [];

  const site = sites.find((s) => s.id === device.displaySiteId);
  if (!site) return [];

  const siteName = garageSheetName(site);
  const positionName = device?.positionName || '';
  const levelAll = insert?.displayLevelAll ?? false;
  const levelIds = Array.isArray(insert?.displayLevelIds) ? insert.displayLevelIds : [];

  if (levelAll) {
    return [[displayName, siteName, 'All', positionName, '']];
  }

  const levelEntries = levelIds.map((levelId) => {
    const level = (site.levels || []).find((l) => l.id === levelId);
    if (!level) return null;
    const sheetName = levelSheetInternalName(level, site.levels);
    return {
      internal: sheetName,
      name: sheetName,
    };
  }).filter(Boolean);

  if (levelEntries.length === 0) return [];

  if (levelEntries.length === 1) {
    const { internal, name } = levelEntries[0];
    return [[displayName, siteName, internal, positionName, name]];
  }

  const levelCell = levelEntries.map((e) => e.internal).join(',');
  return [[displayName, siteName, levelCell, positionName, '']];
}

/**
 * DisplayLevels rows for a sign — one set per insert when inserts are present.
 */
export function buildSignDisplayLevelSheetRows(device, sites = []) {
  if (signUsesInserts(device) && device.inserts.length > 0) {
    return device.inserts.flatMap((insert) => buildLevelRowsForInsert(device, insert, sites));
  }
  return buildDisplayLevelSheetRows(device, sites);
}

/** Short labels for map icon / hover — controller, then each insert on its own line. */
export function signMapLabelLines(device) {
  const controller = String(device?.controllerName || device?.name || '').trim();
  if (signUsesInserts(device) && device.inserts.length > 0) {
    const lines = [];
    if (controller) lines.push(controller);
    for (const ins of device.inserts) {
      const n = String(ins.displayName || '').trim() || signDisplayName(device);
      if (n) lines.push(n);
    }
    return lines.length ? lines : [device?.name || ''];
  }
  return [device?.name || ''];
}

/** Human-readable level summary for an insert in the inspector. */
export function insertLevelSummary(device, insert, sites = []) {
  if (insert?.displayLevelAll) return 'All levels';
  const site = sites.find((s) => s.id === device?.displaySiteId);
  if (!site) return 'No site';
  const ids = Array.isArray(insert?.displayLevelIds) ? insert.displayLevelIds : [];
  if (!ids.length) return 'No level';
  const names = ids.map((id) => {
    const level = (site.levels || []).find((l) => l.id === id);
    return level?.name || level?.internalName || String(id);
  });
  return names.join(', ');
}

/**
 * Group DisplayControllers rows that share controller name + IP into monument groups.
 * Singleton groups stay as single-insert (legacy) devices.
 */
export function groupDisplayControllersByMonument(displayControllersData = []) {
  const groups = new Map();
  const singles = [];

  for (const row of displayControllersData) {
    const controllerName = String(row?.DisplayControllerName || '').trim();
    const ip = String(row?.IPAddress || '').trim();
    const displayName = String(row?.DisplayName || '').trim();
    if (!displayName) continue;

    if (controllerName && ip) {
      const key = `${controllerName.toLowerCase()}||${ip}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    } else {
      singles.push([row]);
    }
  }

  const result = [];
  for (const rows of groups.values()) {
    if (rows.length >= 2) result.push(rows);
    else result.push(rows);
  }
  for (const s of singles) result.push(s);
  return result;
}
