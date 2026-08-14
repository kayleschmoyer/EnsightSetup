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
 * Flatten garage devices, counting each logical sign once (signs may appear on multiple levels).
 */
export function uniqueGarageDevices(garage) {
  const levels = garage?.levels ?? [];
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

export function countGarageDevices(garage) {
  return uniqueGarageDevices(garage).length;
}

export function countGarageDevicesByType(garage) {
  const counts = {};
  uniqueGarageDevices(garage).forEach((device) => {
    if (device.type) counts[device.type] = (counts[device.type] || 0) + 1;
  });
  return counts;
}

export function countGarageDevicesWithTypePrefix(garage, prefix) {
  return uniqueGarageDevices(garage).filter((d) => d.type?.startsWith(prefix)).length;
}

export function countGaragesDevices(garages) {
  return (garages ?? []).reduce((sum, garage) => sum + countGarageDevices(garage), 0);
}

export function countGaragesDevicesWithTypePrefix(garages, prefix) {
  return (garages ?? []).reduce(
    (sum, garage) => sum + countGarageDevicesWithTypePrefix(garage, prefix),
    0,
  );
}

function findSignInGarage(garage, deviceId) {
  for (const level of garage?.levels || []) {
    const device = (level.devices || []).find((d) => d.id === deviceId);
    if (device) return device;
  }
  return null;
}

/**
 * Apply a sign update to all level copies sharing the same logical sign key.
 */
export function applySignUpdateAcrossGarage(garage, deviceId, nextDevice, options = {}) {
  const { stageLevelId, stageMeta = {} } = options;
  const source = findSignInGarage(garage, deviceId);
  if (!source?.type?.startsWith('sign-')) return garage?.levels;

  const matchKey = source.signLogicalKey || signLogicalKey(source);
  const newKey = signLogicalKey(nextDevice);
  const { id: _ignoredId, ...sharedFields } = nextDevice;

  return (garage.levels || []).map((level) => {
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

function maxDeviceId(garages) {
  let max = 0;
  for (const garage of garages || []) {
    for (const level of garage.levels || []) {
      for (const device of level.devices || []) {
        if (Number.isFinite(device.id) && device.id > max) max = device.id;
      }
    }
  }
  return max;
}

function findSignById(garages, deviceId) {
  for (const garage of garages || []) {
    for (const level of garage.levels || []) {
      const device = (level.devices || []).find((d) => d.id === deviceId);
      if (device) return { garage, level, device };
    }
  }
  return null;
}

function collectSignCopies(garages, matchKey) {
  const copies = new Map();
  if (!matchKey) return copies;
  for (const garage of garages || []) {
    for (const level of garage.levels || []) {
      for (const device of level.devices || []) {
        if (!device.type?.startsWith('sign-')) continue;
        const dKey = device.signLogicalKey || signLogicalKey(device);
        if (dKey === matchKey) {
          copies.set(`${garage.id}:${level.id}`, device);
        }
      }
    }
  }
  return copies;
}

function targetLevelIdsForSign(nextDevice, targetGarage) {
  if (!targetGarage) return [];
  if (nextDevice.displayLevelAll) {
    return (targetGarage.levels || []).map((level) => level.id);
  }
  return Array.isArray(nextDevice.displayLevelIds) ? nextDevice.displayLevelIds : [];
}

/**
 * Reconcile sign copies across garages when display level assignment changes,
 * otherwise propagate shared fields to existing copies.
 */
export function reconcileSignInGarages(garages, deviceId, nextDevice, options = {}) {
  const { stageGarageId, stageLevelId, stageMeta = {} } = options;
  const located = findSignById(garages, deviceId);
  if (!located?.device?.type?.startsWith('sign-')) return garages;

  const source = located.device;
  const matchKey = source.signLogicalKey || signLogicalKey(source);
  const newKey = signLogicalKey(nextDevice);
  const { id: _ignoredId, ...sharedFields } = nextDevice;

  const targetGarage = garages.find((g) => g.id === nextDevice.displayGarageId);
  const targetLevelIds = targetLevelIdsForSign(nextDevice, targetGarage);
  const canPlace = targetGarage != null && (nextDevice.displayLevelAll || targetLevelIds.length > 0);

  if (!canPlace) {
    const stageGarage = garages.find((g) => g.id === stageGarageId);
    if (!stageGarage) return garages;
    return garages.map((g) => (g.id !== stageGarageId ? g : {
      ...g,
      levels: applySignUpdateAcrossGarage(stageGarage, deviceId, nextDevice, {
        stageLevelId,
        stageMeta,
      }),
    }));
  }

  const existingCopies = collectSignCopies(garages, matchKey);
  let nextId = maxDeviceId(garages) + 1;
  const template = { ...source, ...sharedFields, signLogicalKey: newKey };

  let nextGarages = garages.map((garage) => ({
    ...garage,
    levels: (garage.levels || []).map((level) => ({
      ...level,
      devices: (level.devices || []).filter((device) => {
        if (!device.type?.startsWith('sign-')) return true;
        const dKey = device.signLogicalKey || signLogicalKey(device);
        return dKey !== matchKey;
      }),
    })),
  }));

  const garageIndex = nextGarages.findIndex((g) => g.id === targetGarage.id);
  if (garageIndex < 0) return nextGarages;

  const updatedGarage = { ...nextGarages[garageIndex] };
  updatedGarage.levels = (updatedGarage.levels || []).map((level) => {
    if (!targetLevelIds.includes(level.id)) {
      const meta = stageGarageId === targetGarage.id && level.id === stageLevelId ? stageMeta : {};
      return { ...level, ...meta };
    }

    const copyKey = `${targetGarage.id}:${level.id}`;
    const existing = existingCopies.get(copyKey);
    const isStageLevel = stageGarageId === targetGarage.id && level.id === stageLevelId;
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

  nextGarages[garageIndex] = updatedGarage;
  return nextGarages;
}

/** Remove all level copies of a logical sign. */
export function removeSignFromGarage(garage, deviceId) {
  const source = findSignInGarage(garage, deviceId);
  if (!source?.type?.startsWith('sign-')) return garage?.levels;

  const matchKey = source.signLogicalKey || signLogicalKey(source);
  return (garage.levels || []).map((level) => ({
    ...level,
    devices: (level.devices || []).filter((d) => {
      if (!d.type?.startsWith('sign-')) return true;
      const dKey = d.signLogicalKey || signLogicalKey(d);
      return d.id !== deviceId && dKey !== matchKey;
    }),
  }));
}
