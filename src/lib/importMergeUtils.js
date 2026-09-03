/**
 * importMergeUtils — merge a freshly imported customer tree
 * (importedWorkbookMapping.buildCustomerFromWorkbook) into the customer
 * already on file, instead of replacing it outright.
 *
 * Matching (by internalName/name/groupId, never by id — imported ids are
 * freshly generated on every parse):
 *   sites             internalName, then name
 *   levels + zones    internalName, under the matched site
 *   devices           name, under the matched level
 *   servers / display groups / sensor groups   name, then groupId
 *
 * A matched entity keeps its existing id and every "app-only" field the
 * sheet has no column for (canvas placement, floor plan / device photos,
 * contacts, quick links, MDF/IDF locations, zone polygon geometry) and
 * takes every other field from the import. An id kept from the existing
 * tree is also substituted back into whatever in the imported tree pointed
 * at the old imported id (device.serverId, trafficFlow.level/.zone, a
 * zone-level's parentLevelId, …) so those references stay resolvable.
 *
 * An imported entity with no match is added. An existing entity with no
 * match is kept (never silently dropped) and reported in `warnings` so the
 * user can see what the sheet no longer lists.
 *
 * Pure and dependency-light (only zoneLevelUtils, for the floor/zone
 * distinction) so it is unit tested without Drive, MySQL or a browser.
 */
import { isZoneLevel } from './zoneLevelUtils';

const DEVICE_APP_FIELDS = ['x', 'y', 'rotation', 'iconSize', 'pendingPlacement', 'viewImage', 'signImages'];
const ZONE_POLYGON_APP_FIELDS = ['points', 'color', 'opacity'];

function normKey(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return key || null;
}

/**
 * Match imported items onto existing items, trying each key field in order
 * (first non-empty key that finds an existing item wins). Never matches two
 * imported items to the same existing item.
 * @returns {{ pairs: {existing:object, imported:object}[], unmatchedImported: object[],
 *   unmatchedExisting: object[], idMap: Map }}
 */
function matchEntities(existingList = [], importedList = [], keyFields = ['name']) {
  const indexes = keyFields.map((field) => {
    const map = new Map();
    for (const item of existingList || []) {
      const key = normKey(item?.[field]);
      if (key && !map.has(key)) map.set(key, item);
    }
    return map;
  });

  const idMap = new Map();
  const matchedExistingIds = new Set();
  const pairs = [];
  const unmatchedImported = [];

  for (const imported of importedList || []) {
    let match = null;
    for (let i = 0; i < keyFields.length && !match; i += 1) {
      const key = normKey(imported?.[keyFields[i]]);
      const candidate = key ? indexes[i].get(key) : null;
      if (candidate && !matchedExistingIds.has(candidate.id)) match = candidate;
    }
    if (match) {
      idMap.set(imported.id, match.id);
      matchedExistingIds.add(match.id);
      pairs.push({ existing: match, imported });
    } else {
      unmatchedImported.push(imported);
    }
  }

  const unmatchedExisting = (existingList || []).filter((item) => !matchedExistingIds.has(item.id));
  return { pairs, unmatchedImported, unmatchedExisting, idMap };
}

/** Copy fields from `existing` onto `imported` when `existing` defines them. */
function keepFields(imported, existing, fields) {
  const merged = { ...imported };
  for (const field of fields) {
    if (existing && existing[field] !== undefined) merged[field] = existing[field];
  }
  return merged;
}

function mapId(idMap, id) {
  if (id == null || id === '') return id;
  return idMap.has(id) ? idMap.get(id) : id;
}

function mergeDevice(existingDevice, importedDevice) {
  return { ...keepFields(importedDevice, existingDevice, DEVICE_APP_FIELDS), id: existingDevice.id };
}

function labelFor(entity, ...fields) {
  for (const field of fields) {
    const value = entity?.[field];
    if (value) return value;
  }
  return entity?.id || 'unnamed';
}

/**
 * Merge one matched site pair (levels/zones/devices/servers/display groups/
 * sensor groups all matched and merged within it).
 */
function mergeSite(existingSite, importedSite, warnings) {
  const siteLabel = labelFor(existingSite, 'internalName', 'name');

  const serverMatch = matchEntities(existingSite.servers, importedSite.servers, ['name']);
  const displayGroupMatch = matchEntities(existingSite.displayGroups, importedSite.displayGroups, ['name']);
  const sensorGroupMatch = matchEntities(existingSite.sensorGroups, importedSite.sensorGroups, ['name', 'groupId']);
  const levelMatch = matchEntities(existingSite.levels, importedSite.levels, ['internalName']);

  // Zone polygons live on the parent floor level's `zones` array; match them
  // by translating the imported zone's linkedLevelId (an imported zone-level
  // id) through levelMatch.idMap and comparing to the existing floor's zones.
  const zonePolygonIdMap = new Map();
  for (const { existing: existingLevel, imported: importedLevel } of levelMatch.pairs) {
    if (isZoneLevel(existingLevel) || isZoneLevel(importedLevel)) continue;
    const existingZones = existingLevel.zones || [];
    for (const zone of importedLevel.zones || []) {
      const translatedLinkedId = mapId(levelMatch.idMap, zone.linkedLevelId);
      const existingZone = existingZones.find((z) => String(z.linkedLevelId) === String(translatedLinkedId));
      if (existingZone) zonePolygonIdMap.set(zone.id, existingZone.id);
    }
  }

  const remapDevice = (device) => {
    const next = { ...device };
    if (next.serverId != null) next.serverId = mapId(serverMatch.idMap, next.serverId);
    if (next.displayGroupId != null) next.displayGroupId = mapId(displayGroupMatch.idMap, next.displayGroupId);
    if (next.configSensorGroupId != null) {
      next.configSensorGroupId = mapId(sensorGroupMatch.idMap, next.configSensorGroupId);
    }
    if (next.trafficFlow) {
      next.trafficFlow = {
        ...next.trafficFlow,
        level: mapId(levelMatch.idMap, next.trafficFlow.level),
        zone: mapId(zonePolygonIdMap, next.trafficFlow.zone),
      };
    }
    return next;
  };

  const remapZones = (importedLevel) => (importedLevel.zones || []).map((zone) => {
    const finalId = mapId(zonePolygonIdMap, zone.id);
    return { ...zone, id: finalId, linkedLevelId: mapId(levelMatch.idMap, zone.linkedLevelId) };
  });

  const mergeLevelPair = (existingLevel, importedLevel) => {
    const levelLabel = labelFor(importedLevel, 'internalName', 'name');
    const zones = remapZones(importedLevel).map((zone) => {
      const existingZone = (existingLevel.zones || []).find((z) => z.id === zone.id);
      return existingZone ? keepFields(zone, existingZone, ZONE_POLYGON_APP_FIELDS) : zone;
    });

    const deviceMatch = matchEntities(existingLevel.devices, importedLevel.devices, ['name']);
    const devices = [
      ...deviceMatch.pairs.map(({ existing, imported }) => mergeDevice(existing, remapDevice(imported))),
      ...deviceMatch.unmatchedImported.map(remapDevice),
    ];
    for (const device of deviceMatch.unmatchedExisting) {
      warnings.push(
        `${siteLabel} / ${levelLabel}: device "${labelFor(device, 'name')}" is no longer on the sheet — kept from the existing setup.`,
      );
      devices.push(device);
    }

    return {
      ...keepFields(importedLevel, existingLevel, ['bgImage']),
      id: existingLevel.id,
      parentLevelId: mapId(levelMatch.idMap, importedLevel.parentLevelId),
      zones,
      devices,
    };
  };

  const levels = [
    ...levelMatch.pairs.map(({ existing, imported }) => mergeLevelPair(existing, imported)),
    ...levelMatch.unmatchedImported.map((level) => ({
      ...level,
      parentLevelId: mapId(levelMatch.idMap, level.parentLevelId),
      zones: remapZones(level),
      devices: (level.devices || []).map(remapDevice),
    })),
  ];
  for (const level of levelMatch.unmatchedExisting) {
    warnings.push(`${siteLabel}: level "${labelFor(level, 'internalName', 'name')}" is no longer on the sheet — kept from the existing setup.`);
    levels.push(level);
  }

  const mergeNamedGroup = (match, kind, ...labelFields) => {
    const merged = [
      ...match.pairs.map(({ existing, imported }) => ({ ...imported, id: existing.id })),
      ...match.unmatchedImported,
    ];
    for (const item of match.unmatchedExisting) {
      warnings.push(`${siteLabel}: ${kind} "${labelFor(item, ...labelFields)}" is no longer on the sheet — kept from the existing setup.`);
      merged.push(item);
    }
    return merged;
  };

  const quickLinks = [
    ...(importedSite.quickLinks || []).filter((link) => link?.icon === 'sheets'),
    ...(existingSite.quickLinks || []).filter((link) => link?.icon !== 'sheets'),
  ];

  return {
    ...keepFields(importedSite, existingSite, ['contacts', 'mdfIdfLocations']),
    id: existingSite.id,
    quickLinks,
    servers: mergeNamedGroup(serverMatch, 'server', 'name'),
    displayGroups: mergeNamedGroup(displayGroupMatch, 'display group', 'name'),
    sensorGroups: mergeNamedGroup(sensorGroupMatch, 'sensor group', 'groupId', 'name'),
    levels,
  };
}

/**
 * Merge `importedCustomer` (a fresh buildCustomerFromWorkbook result) onto
 * `existingCustomer`, keeping app-only data for everything the sheet still
 * lists and reporting what it no longer lists.
 * @returns {object} an importedCustomer-shaped object (same top-level fields,
 *   including `warnings`) with `sites` merged.
 */
export function mergeImportedCustomer(existingCustomer, importedCustomer) {
  const warnings = [];
  const existingSites = existingCustomer?.sites || [];
  const importedSites = importedCustomer?.sites || [];

  const siteMatch = matchEntities(existingSites, importedSites, ['internalName', 'name']);
  const sites = [
    ...siteMatch.pairs.map(({ existing, imported }) => mergeSite(existing, imported, warnings)),
    ...siteMatch.unmatchedImported,
  ];
  for (const site of siteMatch.unmatchedExisting) {
    warnings.push(`Site "${labelFor(site, 'internalName', 'name')}" is no longer on the sheet — kept from the existing setup.`);
    sites.push(site);
  }

  return {
    ...importedCustomer,
    sites,
    warnings: [...(importedCustomer?.warnings || []), ...warnings],
  };
}
