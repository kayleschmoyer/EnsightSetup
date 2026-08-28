/** Camera device name suffixes by type: 1.1F, 1.2L, 1.3P */
export const CAMERA_PREFIX = {
  'cam-fli': 'F',
  'cam-lpr': 'L',
  'cam-people': 'P',
};

export function isCameraType(type) {
  return Object.prototype.hasOwnProperty.call(CAMERA_PREFIX, type);
}

/**
 * Canonical camera hardware type for comparisons / Select values.
 * Imports historically used "Bullet"; editor uses "bullet" / "dual-lens".
 * Does not write anything — read-only normalization.
 */
export function normalizeCameraHardwareType(hardwareType) {
  const hw = String(hardwareType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (hw === 'dual-lens' || hw === 'duallens') return 'dual-lens';
  if (hw === 'bullet') return 'bullet';
  return null;
}

/** True when this device is dual-lens hardware (canonical or legacy label). */
export function isDualLensCamera(device) {
  return normalizeCameraHardwareType(device?.hardwareType) === 'dual-lens';
}

/**
 * Human level number for device IDs (1.1F, S1.1) — not the internal level.id.
 * Prefer sheet ordinals, then majority of existing device names, then site order.
 */
export function getLevelNamingNumber(level, levels = []) {
  if (!level) return 1;

  const fromConfig = Number(
    level.config?.signDisplayOrdinal ?? level.config?.portalDisplayOrdinal,
  );
  if (Number.isFinite(fromConfig) && fromConfig > 0) return Math.floor(fromConfig);

  const counts = new Map();
  for (const device of level.devices || []) {
    const match = String(device?.name || '').trim().match(/^[A-Z]*?(\d+)\.\d+/i);
    if (!match) continue;
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  if (counts.size) {
    let best = 1;
    let bestCount = -1;
    for (const [n, count] of counts) {
      if (count > bestCount) {
        best = n;
        bestCount = count;
      }
    }
    return best;
  }

  const idx = (levels || []).findIndex((l) => l.id === level.id);
  if (idx >= 0) return idx + 1;

  return 1;
}

export function nextCameraName(prefix, levelNumber, usedNames) {
  let n = 1;
  while (usedNames.has(`${levelNumber}.${n}${prefix}`)) n += 1;
  return `${levelNumber}.${n}${prefix}`;
}

/** Signs use a leading S: S1.1, S1.2, S2.1. */
export function nextSignName(levelNumber, usedNames) {
  let n = 1;
  while (usedNames.has(`S${levelNumber}.${n}`)) n += 1;
  return `S${levelNumber}.${n}`;
}

/** Parse level.seq names like 1.1F, 1.10L, 1.3F-S2, 1.1NW, S1.1 */
function parseDeviceSortKey(name) {
  const raw = String(name || '').trim();
  const match = raw.match(/^([A-Z]*?)(\d+)\.(\d+)([A-Z]*)?(?:-S(\d+))?$/i);
  if (!match) {
    return {
      level: Number.MAX_SAFE_INTEGER,
      seq: Number.MAX_SAFE_INTEGER,
      suffix: 'zzz',
      stream: 0,
      raw,
    };
  }
  return {
    level: Number(match[2]),
    seq: Number(match[3]),
    suffix: (match[1] || '') + (match[4] || ''),
    stream: Number(match[5] || 0),
    raw,
  };
}

/** Sort camera/device names: 1.1 first, higher sequences below (numeric, not lexical). */
export function compareCameraNames(a, b) {
  const ka = parseDeviceSortKey(a);
  const kb = parseDeviceSortKey(b);
  if (ka.level !== kb.level) return ka.level - kb.level;
  if (ka.seq !== kb.seq) return ka.seq - kb.seq;
  if (ka.suffix !== kb.suffix) return ka.suffix.localeCompare(kb.suffix);
  if (ka.stream !== kb.stream) return ka.stream - kb.stream;
  return ka.raw.localeCompare(kb.raw);
}

export function sortByCameraName(items, getName = (item) => item) {
  return [...items].sort((a, b) => compareCameraNames(getName(a), getName(b)));
}

/**
 * Pick the next available camera name for the target type on this level.
 * e.g. moving 1.5F → LPR when 1.1L and 1.2L exist becomes 1.3L.
 */
export function cameraNameForTypeChange(device, newType, levelNumber, allDevices) {
  const newPrefix = CAMERA_PREFIX[newType];
  if (!newPrefix) return device?.name || '';

  const used = new Set(
    (allDevices || []).filter((d) => d.id !== device.id).map((d) => d.name),
  );

  return nextCameraName(newPrefix, levelNumber, used);
}

export function withStreamType(stream, type) {
  if (typeof stream === 'object' && stream !== null) {
    return { ...stream, streamType: type };
  }
  return {
    ipAddress: '',
    port: '554',
    externalUrl: typeof stream === 'string' ? stream : '',
    streamType: type,
  };
}

/** Collect all camera names already in use on a level (including dual-lens stream sheet names). */
export function collectUsedCameraNames(devices, excludeId = null) {
  const used = new Set();
  for (const d of devices || []) {
    if (excludeId != null && d.id === excludeId) continue;
    if (d.name) used.add(d.name);
    if (d.stream1?.configSheetName) used.add(d.stream1.configSheetName);
    if (d.stream2?.configSheetName) used.add(d.stream2.configSheetName);
  }
  return used;
}

/** Short label for camera stream types (sidebar / inspector). */
export function cameraTypeShortLabel(type) {
  return {
    'cam-fli': 'FLI',
    'cam-lpr': 'LPR',
    'cam-people': 'People',
  }[type] || 'Cam';
}

/**
 * Default Stream 2 type when converting a single camera to dual-lens.
 * FLI ↔ LPR pair is the common hardware combo; otherwise keep the same type (-S2).
 */
export function defaultSecondStreamType(stream1Type) {
  if (stream1Type === 'cam-fli') return 'cam-lpr';
  if (stream1Type === 'cam-lpr') return 'cam-fli';
  return stream1Type || 'cam-fli';
}

/**
 * Parse camera sheet IDs like 1.1F, ENSA-WALLER-1.1L, ENSA-WALLER-1.1F-S2.
 * @returns {{ prefix: string, level: string, seq: string, typeSuffix: string, stream: number, raw: string } | null}
 */
export function parseCameraSheetId(name) {
  const raw = String(name || '').trim();
  const match = raw.match(/^(.*?)(\d+)\.(\d+)([A-Z]+)(?:-S(\d+))?$/i);
  if (!match) return null;
  return {
    prefix: match[1] || '',
    level: match[2],
    seq: match[3],
    typeSuffix: String(match[4] || '').toUpperCase(),
    stream: match[5] ? Number(match[5]) : 0,
    raw,
  };
}

/** Prefer a site prefix already used on this level (e.g. ENSA-WALLER-). */
function inferCameraNamePrefix(usedNames, preferredName = '') {
  const fromPreferred = parseCameraSheetId(preferredName)?.prefix;
  if (fromPreferred) return fromPreferred;

  const counts = new Map();
  for (const name of usedNames || []) {
    const prefix = parseCameraSheetId(name)?.prefix;
    if (!prefix) continue;
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [prefix, count] of counts) {
    if (count > bestCount) {
      best = prefix;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Pick paired names for a dual-lens camera.
 * Mixed types (FLI + LPR) share a sequence: 1.1F + 1.1L (or ENSA-WALLER-1.1F + ENSA-WALLER-1.1L).
 * Same-type dual streams use 1.1F + 1.1F-S2.
 * When converting an existing camera, pass existingName so the full ID is preserved.
 *
 * @param {number|string} levelId
 * @param {string} stream1Type
 * @param {string} stream2Type
 * @param {Set<string>} usedNames
 * @param {{ existingName?: string, existingStream1Name?: string, existingStream2Name?: string }} [options]
 */
export function assignDualLensStreamNames(levelId, stream1Type, stream2Type, usedNames, options = {}) {
  const p1 = CAMERA_PREFIX[stream1Type];
  const p2 = CAMERA_PREFIX[stream2Type];
  if (!p1) {
    return { deviceName: 'Camera', stream1SheetName: 'Camera', stream2SheetName: 'Camera-S2' };
  }

  const existingName = String(options.existingName || '').trim();
  const existingStream1Name = String(options.existingStream1Name || '').trim();
  const seedName = existingStream1Name || existingName;
  const allowed = new Set(
    [existingName, existingStream1Name, options.existingStream2Name]
      .map((v) => String(v || '').trim())
      .filter(Boolean),
  );
  const isBlocked = (name) => usedNames.has(name) && !allowed.has(name);
  const sitePrefix = inferCameraNamePrefix(usedNames, seedName);

  const pairFor = (prefix, levelNum, seq) => {
    const stream1SheetName = `${prefix}${levelNum}.${seq}${p1}`;
    const stream2SheetName = (!p2 || stream1Type === stream2Type)
      ? `${stream1SheetName}-S2`
      : `${prefix}${levelNum}.${seq}${p2}`;
    if (isBlocked(stream1SheetName) || isBlocked(stream2SheetName)) return null;
    return { deviceName: stream1SheetName, stream1SheetName, stream2SheetName };
  };

  // Prefer keeping the imported / current sequence + site prefix.
  const parsed = parseCameraSheetId(seedName);
  if (parsed) {
    const kept = pairFor(parsed.prefix || sitePrefix, parsed.level, parsed.seq);
    if (kept) return kept;
    // Complementary ID is already used by another camera (e.g. 1.1L exists).
    // Keep THIS camera's stream-1 ID and use -S2 — never rename it or steal
    // another camera's sheet row.
    if (seedName) {
      const stream1SheetName = `${parsed.prefix || sitePrefix}${parsed.level}.${parsed.seq}${p1}`;
      const stream2SheetName = `${stream1SheetName}-S2`;
      if (!isBlocked(stream1SheetName) && !isBlocked(stream2SheetName)) {
        return { deviceName: stream1SheetName, stream1SheetName, stream2SheetName };
      }
    }
  }

  let n = 1;
  while (n < 10000) {
    const pair = pairFor(sitePrefix, levelId, n);
    if (pair) return pair;
    n += 1;
  }

  const fallback = `${sitePrefix}${nextCameraName(p1, levelId, usedNames)}`;
  return {
    deviceName: fallback,
    stream1SheetName: fallback,
    stream2SheetName: `${fallback}-S2`,
  };
}

/**
 * Apply dual-lens stream naming to a device object.
 * @param {{ preserveName?: boolean }} [options] - preserveName false forces a new sequence (copy/add).
 */
export function applyDualLensNaming(device, levelId, allDevices, excludeId = null, options = {}) {
  if (!isDualLensCamera(device) || !device.stream2 || typeof device.stream2 !== 'object') {
    return device;
  }

  const t1 = device.stream1?.streamType || device.type;
  const t2 = device.stream2?.streamType || device.type;
  const used = collectUsedCameraNames(allDevices, excludeId);
  const preserveName = options.preserveName !== false;
  const naming = assignDualLensStreamNames(levelId, t1, t2, used, {
    existingName: preserveName ? device.name : '',
    existingStream1Name: preserveName ? device.stream1?.configSheetName : '',
    existingStream2Name: preserveName ? device.stream2?.configSheetName : '',
  });

  return {
    ...device,
    type: t1,
    name: naming.deviceName,
    stream1: {
      ...withStreamType(device.stream1, t1),
      configSheetName: naming.stream1SheetName,
    },
    stream2: {
      ...withStreamType(device.stream2, t2),
      configSheetName: naming.stream2SheetName,
    },
  };
}

/** Sheet row key for a camera stream (dual-lens may use per-stream names). */
export function streamSyncSheetName(device, streamNum) {
  const streamKey = streamNum === 1 ? 'stream1' : 'stream2';
  const stream = device[streamKey];
  if (stream?.configSheetName) return stream.configSheetName;
  if (isDualLensCamera(device) && streamNum === 2) {
    const t1 = device.stream1?.streamType || device.type;
    const t2 = device.stream2?.streamType || device.type;
    if (t1 !== t2 && device.name && device.stream2) {
      const p2 = CAMERA_PREFIX[t2];
      const parsed = parseCameraSheetId(device.name);
      if (p2 && parsed) {
        return `${parsed.prefix}${parsed.level}.${parsed.seq}${p2}`;
      }
    }
    return `${device.name}-S2`;
  }
  return device.name;
}

/**
 * Expand dual-lens cameras with mixed stream types into separate sidebar rows
 * so each stream appears under its camera-type group (e.g. 1.1F under FLI, 1.1L under LPR).
 */
export function expandDevicesForSidebar(devices) {
  const rows = [];
  for (const device of devices || []) {
    if (isDualLensCamera(device) && device.stream2 && typeof device.stream2 === 'object') {
      const t1 = device.stream1?.streamType || device.type;
      const t2 = device.stream2?.streamType || device.type;
      if (t1 !== t2) {
        rows.push({
          device,
          sidebarName: device.stream1?.configSheetName || device.name,
          groupType: t1,
          streamKey: 'stream1',
        });
        rows.push({
          device,
          sidebarName: device.stream2?.configSheetName || streamSyncSheetName(device, 2),
          groupType: t2,
          streamKey: 'stream2',
        });
        continue;
      }
    }
    rows.push({ device, sidebarName: device.name, groupType: device.type, streamKey: null });
  }
  return rows;
}

/** Relative cone offset (degrees from device facing) → Konva wedge rotation. */
export function coneWedgeRotation(coneOffsetDeg = 0) {
  return (coneOffsetDeg || 0) - 30;
}
