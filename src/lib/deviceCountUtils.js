import { signDisplayName } from './configSheetSchema';

/** Stable key for deduplicating / syncing multi-level sign copies. */
export function signLogicalKey(device) {
  if (device?.signLogicalKey) return String(device.signLogicalKey).trim().toLowerCase();
  const name = signDisplayName(device) || device?.name || device?.friendlyName || '';
  const key = String(name).trim().toLowerCase();
  if (key) return key;
  if (device?.id != null) return `__id_${device.id}`;
  return '';
}

/**
 * Flatten site devices, counting each logical sign once (signs may appear on multiple levels).
 */
export function uniqueSiteDevices(site) {
  const levels = site?.levels ?? [];
  const seenSigns = new Set();
  const unique = [];

  for (const level of levels) {
    for (const device of level.devices || []) {
      if (device.type?.startsWith('sign-')) {
        const key = signLogicalKey(device);
        if (!key || seenSigns.has(key)) continue;
        seenSigns.add(key);
      }
      unique.push(device);
    }
  }

  return unique;
}

export function countSiteDevices(site) {
  return uniqueSiteDevices(site).length;
}

export function countSiteDevicesByType(site) {
  const counts = {};
  uniqueSiteDevices(site).forEach((device) => {
    if (device.type) counts[device.type] = (counts[device.type] || 0) + 1;
  });
  return counts;
}

export function countSiteDevicesWithTypePrefix(site, prefix) {
  return uniqueSiteDevices(site).filter((d) => d.type?.startsWith(prefix)).length;
}

export function countSitesDevices(sites) {
  return (sites ?? []).reduce((sum, site) => sum + countSiteDevices(site), 0);
}

export function countSitesDevicesWithTypePrefix(sites, prefix) {
  return (sites ?? []).reduce(
    (sum, site) => sum + countSiteDevicesWithTypePrefix(site, prefix),
    0,
  );
}

function findSignInSite(site, deviceId) {
  for (const level of site?.levels || []) {
    const device = (level.devices || []).find((d) => d.id === deviceId);
    if (device) return device;
  }
  return null;
}

/**
 * Apply a sign update to all level copies sharing the same logical sign key.
 */
export function applySignUpdateAcrossSite(site, deviceId, nextDevice, options = {}) {
  const { stageLevelId, stageMeta = {} } = options;
  const source = findSignInSite(site, deviceId);
  if (!source?.type?.startsWith('sign-')) return site?.levels;

  const matchKey = source.signLogicalKey || signLogicalKey(source);
  const newKey = signLogicalKey(nextDevice);
  const { id: _ignoredId, ...sharedFields } = nextDevice;

  return (site.levels || []).map((level) => {
    const devices = (level.devices || []).map((d) => {
      if (!d.type?.startsWith('sign-')) return d;
      const dKey = d.signLogicalKey || signLogicalKey(d);
      if (d.id === deviceId || (matchKey && dKey === matchKey)) {
        return { ...d, ...sharedFields, id: d.id, signLogicalKey: newKey };
      }
      return d;
    });
    const meta = stageLevelId != null && level.id === stageLevelId ? stageMeta : {};
    return { ...level, devices, ...meta };
  });
}

function maxDeviceId(sites) {
  let max = 0;
  for (const site of sites || []) {
    for (const level of site.levels || []) {
      for (const device of level.devices || []) {
        if (Number.isFinite(device.id) && device.id > max) max = device.id;
      }
    }
  }
  return max;
}

function findSignById(sites, deviceId) {
  for (const site of sites || []) {
    for (const level of site.levels || []) {
      const device = (level.devices || []).find((d) => d.id === deviceId);
      if (device) return { site, level, device };
    }
  }
  return null;
}

function collectSignCopies(sites, matchKey) {
  const copies = new Map();
  if (!matchKey) return copies;
  for (const site of sites || []) {
    for (const level of site.levels || []) {
      for (const device of level.devices || []) {
        if (!device.type?.startsWith('sign-')) continue;
        const dKey = device.signLogicalKey || signLogicalKey(device);
        if (dKey === matchKey) {
          copies.set(`${site.id}:${level.id}`, device);
        }
      }
    }
  }
  return copies;
}

function targetLevelIdsForSign(nextDevice, targetSite) {
  if (!targetSite) return [];
  if (nextDevice.displayLevelAll) {
    return (targetSite.levels || []).map((level) => level.id);
  }
  return Array.isArray(nextDevice.displayLevelIds) ? nextDevice.displayLevelIds : [];
}

/**
 * Reconcile sign copies across sites when display level assignment changes,
 * otherwise propagate shared fields to existing copies.
 */
export function reconcileSignInSites(sites, deviceId, nextDevice, options = {}) {
  const { stageSiteId, stageLevelId, stageMeta = {} } = options;
  const located = findSignById(sites, deviceId);
  if (!located?.device?.type?.startsWith('sign-')) return sites;

  const source = located.device;
  const matchKey = source.signLogicalKey || signLogicalKey(source);
  const newKey = signLogicalKey(nextDevice);
  const { id: _ignoredId, ...sharedFields } = nextDevice;

  const targetSite = sites.find((s) => s.id === nextDevice.displaySiteId);
  const targetLevelIds = targetLevelIdsForSign(nextDevice, targetSite);
  const canPlace = targetSite != null && (nextDevice.displayLevelAll || targetLevelIds.length > 0);

  if (!canPlace) {
    const stageSite = sites.find((s) => s.id === stageSiteId);
    if (!stageSite) return sites;
    return sites.map((s) => (s.id !== stageSiteId ? s : {
      ...s,
      levels: applySignUpdateAcrossSite(stageSite, deviceId, nextDevice, {
        stageLevelId,
        stageMeta,
      }),
    }));
  }

  const existingCopies = collectSignCopies(sites, matchKey);
  let nextId = maxDeviceId(sites) + 1;
  const template = { ...source, ...sharedFields, signLogicalKey: newKey };

  let nextSites = sites.map((site) => ({
    ...site,
    levels: (site.levels || []).map((level) => ({
      ...level,
      devices: (level.devices || []).filter((device) => {
        if (!device.type?.startsWith('sign-')) return true;
        const dKey = device.signLogicalKey || signLogicalKey(device);
        return dKey !== matchKey;
      }),
    })),
  }));

  const siteIndex = nextSites.findIndex((s) => s.id === targetSite.id);
  if (siteIndex < 0) return nextSites;

  const updatedSite = { ...nextSites[siteIndex] };
  updatedSite.levels = (updatedSite.levels || []).map((level) => {
    if (!targetLevelIds.includes(level.id)) {
      const meta = stageSiteId === targetSite.id && level.id === stageLevelId ? stageMeta : {};
      return { ...level, ...meta };
    }

    const copyKey = `${targetSite.id}:${level.id}`;
    const existing = existingCopies.get(copyKey);
    const isStageLevel = stageSiteId === targetSite.id && level.id === stageLevelId;
    const copyId = existing?.id ?? (isStageLevel ? deviceId : nextId++);

    const copy = {
      ...template,
      id: copyId,
      pendingPlacement: isStageLevel
        ? (template.pendingPlacement ?? existing?.pendingPlacement ?? true)
        : (existing?.pendingPlacement ?? true),
      x: isStageLevel ? (template.x ?? existing?.x ?? 0) : (existing?.x ?? 0),
      y: isStageLevel ? (template.y ?? existing?.y ?? 0) : (existing?.y ?? 0),
      rotation: isStageLevel
        ? (template.rotation ?? existing?.rotation ?? 0)
        : (existing?.rotation ?? template.rotation ?? 0),
    };
    const meta = isStageLevel ? stageMeta : {};
    return {
      ...level,
      devices: [...(level.devices || []), copy],
      ...meta,
    };
  });

  nextSites[siteIndex] = updatedSite;
  return nextSites;
}

/** Remove all level copies of a logical sign. */
export function removeSignFromSite(site, deviceId) {
  const source = findSignInSite(site, deviceId);
  if (!source?.type?.startsWith('sign-')) return site?.levels;

  const matchKey = source.signLogicalKey || signLogicalKey(source);
  return (site.levels || []).map((level) => ({
    ...level,
    devices: (level.devices || []).filter((d) => {
      if (!d.type?.startsWith('sign-')) return true;
      const dKey = d.signLogicalKey || signLogicalKey(d);
      return d.id !== deviceId && dKey !== matchKey;
    }),
  }));
}
