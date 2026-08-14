import { isZoneLevel } from './zoneLevelUtils';

const LEGACY_DIRECTION_MAP = {
  both: 'in',
  into: 'in',
  outof: 'out',
};

/**
 * Normalize legacy traffic direction values to `in` or `out`.
 * Returns empty string when direction is unset or unrecognized.
 */
export function normalizeTrafficDirection(direction) {
  if (!direction) return '';
  if (direction === 'in' || direction === 'out') return direction;
  return LEGACY_DIRECTION_MAP[direction] ?? '';
}

/**
 * User-facing label for PDF and reports.
 */
export function formatTrafficDirectionLabel(direction) {
  const normalized = normalizeTrafficDirection(direction);
  if (!normalized) return '-';
  if (normalized === 'in') return 'In';
  if (normalized === 'out') return 'Out';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Inverse flow direction — a camera counting OUT of its own level is
 * implicitly counting IN to its destination level, and vice versa.
 */
export function invertTrafficDirection(direction) {
  const normalized = normalizeTrafficDirection(direction);
  if (normalized === 'in') return 'out';
  if (normalized === 'out') return 'in';
  return '';
}

/**
 * A camera's "back of car is" flow points at a target: a whole level, or one
 * zone on a level. Targets are stored as `trafficFlow.level` + optional
 * `trafficFlow.zone`; the combined key below is only a UI/select value.
 */
const FLOW_TARGET_SEPARATOR = ':';

export function flowTargetKey(levelId, zoneId) {
  if (levelId == null || levelId === '') return '';
  const level = String(levelId);
  if (zoneId == null || zoneId === '') return level;
  return `${level}${FLOW_TARGET_SEPARATOR}${zoneId}`;
}

export function parseFlowTargetKey(key) {
  const raw = String(key ?? '');
  if (!raw) return { levelId: '', zoneId: '' };
  const separatorIndex = raw.indexOf(FLOW_TARGET_SEPARATOR);
  if (separatorIndex < 0) return { levelId: raw, zoneId: '' };
  return {
    levelId: raw.slice(0, separatorIndex),
    zoneId: raw.slice(separatorIndex + 1),
  };
}

function findLevel(levels, levelId) {
  if (!Array.isArray(levels) || levelId == null || levelId === '') return null;
  return levels.find((level) => String(level?.id) === String(levelId)) ?? null;
}

function findZone(level, zoneId) {
  if (!level || zoneId == null || zoneId === '') return null;
  return (level.zones ?? []).find((zone) => String(zone?.id) === String(zoneId)) ?? null;
}

export function levelsHaveZones(levels) {
  if (!Array.isArray(levels)) return false;
  return levels.some((level) => (level?.zones ?? []).length > 0);
}

/**
 * Selectable flow targets: each level, followed by its zones.
 * @param {object[]} levels
 * @returns {{ key: string, levelId: string, zoneId: string, label: string, isZone: boolean }[]}
 */
export function flowTargetOptions(levels) {
  if (!Array.isArray(levels)) return [];
  const options = [];
  levels.forEach((level) => {
    if (!level || level.id == null) return;
    // Zone-levels are targeted via the parent floor polygon (linkedLevelId),
    // not as standalone floor entries in the traffic picker.
    if (isZoneLevel(level)) return;
    const levelName = level.name || `Level ${level.id}`;
    options.push({
      key: flowTargetKey(level.id, ''),
      levelId: String(level.id),
      zoneId: '',
      label: levelName,
      isZone: false,
    });
    (level.zones ?? []).forEach((zone) => {
      if (!zone || zone.id == null) return;
      let label = zone.name || `Zone ${zone.id}`;
      if (zone.linkedLevelId != null) {
        const linked = levels.find((l) => String(l?.id) === String(zone.linkedLevelId));
        if (linked?.name) label = linked.name;
      }
      options.push({
        key: flowTargetKey(level.id, zone.id),
        levelId: String(level.id),
        zoneId: String(zone.id),
        label,
        isZone: true,
      });
    });
  });
  return options;
}

/**
 * Select value for a stored target, dropping a zone that no longer exists so
 * the control falls back to the whole level instead of showing blank.
 */
export function resolveFlowTargetKey(levels, levelId, zoneId) {
  const level = findLevel(levels, levelId);
  if (!level) return '';
  return flowTargetKey(level.id, findZone(level, zoneId) ? zoneId : '');
}

/** Human-readable target, e.g. "Level 1" or "Level 1 Zone 1". */
export function flowTargetLabel(levels, levelId, zoneId, fallback = 'this level') {
  const level = findLevel(levels, levelId);
  if (!level) return fallback;
  const levelName = level.name || fallback;
  const zone = findZone(level, zoneId);
  if (!zone) return levelName;
  if (zone.linkedLevelId != null) {
    const linked = (levels || []).find((l) => String(l?.id) === String(zone.linkedLevelId));
    if (linked?.name) return linked.name;
  }
  return `${levelName} › ${zone.name || `Zone ${zone.id}`}`;
}

/**
 * Opposite-flow destinations as target keys. Entries were bare level ids
 * before zones were selectable, and a bare level id already stringifies to a
 * valid whole-level key, so normalizing is just de-duplicated stringification.
 * @param {(string|number)[]} destinations
 * @returns {string[]}
 */
export function normalizeFlowDestinations(destinations) {
  if (!Array.isArray(destinations)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of destinations) {
    const key = entry == null ? '' : String(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/** True when an opposite-flow destination lands on `levelId` (zone or whole level). */
export function flowDestinationMatchesLevel(destination, levelId) {
  if (levelId == null) return false;
  return parseFlowTargetKey(destination).levelId === String(levelId);
}

/**
 * Targets selectable as opposite-flow destinations — everything except the
 * camera's own primary target. Other zones on the primary level stay available
 * so a camera can pair one zone against another on the same level.
 */
export function flowDestinationOptions(levels, primaryTargetKey) {
  return flowTargetOptions(levels).filter((option) => option.key !== primaryTargetKey);
}

/**
 * Cameras on other levels acting as virtual counters for `levelId`.
 * Two cases — no physical camera exists on this level for either flow:
 * - the camera's primary "back of car is" flow targets this level
 *   (trafficFlow.level) → counts with its own direction;
 * - a trafficFlow.destinations entry lands on this level (flagged ramp
 *   cameras) → counts with the inverse direction.
 *
 * A camera pairing two zones on the same level yields both entries, which nets
 * to zero for the level — correct, since moving between zones doesn't change
 * level occupancy. Each entry carries a `role` so consumers can key them apart.
 */
export function virtualCountersForLevel(levels, levelId) {
  if (!Array.isArray(levels) || levelId == null) return [];
  const result = [];
  levels.forEach((level) => {
    if (level.id === levelId) return;
    (level.devices ?? []).forEach((device) => {
      if (!device?.type?.startsWith('cam-')) return;
      const flow = device.trafficFlow || {};
      const direction = normalizeTrafficDirection(flow.direction);
      if (!direction) return;

      if (flow.level && String(flow.level) === String(levelId)) {
        result.push({
          device,
          sourceLevel: level,
          direction,
          role: 'primary',
          targetLabel: flowTargetLabel(levels, flow.level, flow.zone),
        });
      }

      // Opt-in only; legacy devices without the flag count if they have destinations.
      if (flow.multiLevel === false) return;
      const destination = normalizeFlowDestinations(flow.destinations)
        .find((entry) => flowDestinationMatchesLevel(entry, levelId));
      if (destination) {
        const { levelId: destLevelId, zoneId } = parseFlowTargetKey(destination);
        result.push({
          device,
          sourceLevel: level,
          direction: invertTrafficDirection(direction),
          role: 'opposite',
          targetLabel: flowTargetLabel(levels, destLevelId, zoneId),
        });
      }
    });
  });
  return result;
}

/**
 * Resolve direction for Epic/config export (defaults to `in`).
 */
export function resolveTrafficDirectionForExport(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeTrafficDirection(candidate);
    if (normalized) return normalized;
  }
  return 'in';
}

function normalizeStreamDirection(stream) {
  if (!stream || typeof stream !== 'object' || !stream.direction) return stream;
  const normalized = normalizeTrafficDirection(stream.direction);
  if (normalized === stream.direction) return stream;
  return { ...stream, direction: normalized };
}

/**
 * Normalize traffic direction fields on a camera device.
 */
export function normalizeDeviceTrafficFlow(device) {
  if (!device?.type?.startsWith('cam-')) return device;

  let updated = { ...device };

  if (updated.trafficFlow?.direction) {
    const normalized = normalizeTrafficDirection(updated.trafficFlow.direction);
    if (normalized !== updated.trafficFlow.direction) {
      updated = {
        ...updated,
        trafficFlow: { ...updated.trafficFlow, direction: normalized },
      };
    }
  }

  if (updated.stream1) {
    const stream1 = normalizeStreamDirection(updated.stream1);
    if (stream1 !== updated.stream1) updated = { ...updated, stream1 };
  }

  if (updated.stream2) {
    const stream2 = normalizeStreamDirection(updated.stream2);
    if (stream2 !== updated.stream2) updated = { ...updated, stream2 };
  }

  if (updated.direction) {
    const normalized = normalizeTrafficDirection(updated.direction);
    if (normalized !== updated.direction) {
      updated = { ...updated, direction: normalized };
    }
  }

  return updated;
}

/**
 * Normalize traffic directions for all camera devices under customers.
 */
export function normalizeCustomersTrafficFlow(customers) {
  if (!Array.isArray(customers)) return customers;
  return customers.map((customer) => ({
    ...customer,
    // `null` garages means "not read from the sheet yet" and must survive
    // normalization — collapsing it to [] would claim the customer has no
    // sites, which is exactly the lie this whole change removes.
    garages: customer.garages == null ? customer.garages : customer.garages.map((garage) => ({
      ...garage,
      levels: (garage.levels ?? []).map((level) => ({
        ...level,
        devices: (level.devices ?? []).map(normalizeDeviceTrafficFlow),
      })),
    })),
  }));
}
