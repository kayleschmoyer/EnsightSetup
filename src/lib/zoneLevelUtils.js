/** Historic LevelType value; sheets now use FLI for zone-levels too. */
export const ZONE_LEVEL_TYPE = 'Zone';

/**
 * True when this site level is a zone.
 * Zone identity lives on `isZone` / parentLevelId in SetupJson. GarageLevels
 * LevelType is FLI (same as floors) — older snapshots may still say Zone.
 */
export function isZoneLevel(level) {
  if (!level) return false;
  if (level.isZone === true) return true;
  const type = String(level.config?.levelType || '').trim();
  return type.toLowerCase() === 'zone';
}

/** Floor levels only (excludes zone-levels). */
export function floorLevels(levels = []) {
  return (levels || []).filter((level) => !isZoneLevel(level));
}

/** Zone-levels only. */
export function zoneLevels(levels = []) {
  return (levels || []).filter((level) => isZoneLevel(level));
}

/**
 * Next short auto name for a zone under a parent, e.g. "Zone 1".
 * App/UI name stays short; sheet name is composed with the parent.
 */
export function nextZoneLevelName(parentLevel, levels = [], excludeLevelId = null) {
  let max = 0;
  for (const level of levels || []) {
    if (excludeLevelId != null && level.id === excludeLevelId) continue;
    if (!isZoneLevel(level)) continue;
    if (String(level.parentLevelId) !== String(parentLevel?.id)) continue;
    const name = String(level.name || level.internalName || '').trim();
    const match = name.match(/(?:^|\s)Zone\s+(\d+)$/i);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `Zone ${max + 1}`;
}

/**
 * True when another zone under the same parent floor already uses this name
 * (case-insensitive, trimmed). Excludes `excludeLevelId` so editing a zone
 * without renaming it doesn't collide with itself.
 */
export function isDuplicateZoneName(name, parentLevelId, levels = [], excludeLevelId = null) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return false;
  return (levels || []).some((level) => {
    if (excludeLevelId != null && level.id === excludeLevelId) return false;
    if (!isZoneLevel(level)) return false;
    if (String(level.parentLevelId) !== String(parentLevelId)) return false;
    return String(level.name || level.internalName || '').trim().toLowerCase() === target;
  });
}

/**
 * GarageLevels / FLICameras Level cell for a zone-level:
 * "{ParentLevelName} {ZoneName}" e.g. "Level 1 Zone 1".
 * Non-zones return their normal internal/name.
 */
export function zoneSheetLevelName(zoneLevel, levels = []) {
  if (!zoneLevel) return '';
  const shortName = String(zoneLevel.name || zoneLevel.internalName || '').trim();
  if (!isZoneLevel(zoneLevel)) {
    return shortName || String(zoneLevel.internalName || zoneLevel.name || '');
  }
  const parent = (levels || []).find((l) => String(l.id) === String(zoneLevel.parentLevelId));
  const parentName = String(parent?.name || parent?.internalName || '').trim();
  if (!parentName) return shortName;
  if (!shortName) return parentName;
  // Legacy rows already stored as "Level 1 Zone 1" — don't double-prefix.
  if (shortName.toLowerCase().startsWith(`${parentName.toLowerCase()} `)) {
    return shortName;
  }
  return `${parentName} ${shortName}`;
}

/** Default rectangle polygon centered on the logical canvas. */
export function defaultZonePolygonPoints(logicalW = 1000, logicalH = 1000) {
  const cx = Math.round(logicalW / 2);
  const cy = Math.round(logicalH / 2);
  const hw = 80;
  const hh = 50;
  return [
    { x: cx - hw, y: cy - hh },
    { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh },
    { x: cx - hw, y: cy + hh },
  ];
}

/**
 * Ensure the parent floor has a polygon linked to this zone-level.
 * Updates polygon name when the link already exists.
 */
export function ensureLinkedZonePolygon(levels, zoneLevel, parentLevelId, { logicalW = 1000, logicalH = 1000 } = {}) {
  if (!zoneLevel || parentLevelId == null) return levels || [];
  return (levels || []).map((level) => {
    if (String(level.id) !== String(parentLevelId)) return level;
    const zones = Array.isArray(level.zones) ? [...level.zones] : [];
    const existingIdx = zones.findIndex(
      (z) => z && String(z.linkedLevelId) === String(zoneLevel.id),
    );
    if (existingIdx >= 0) {
      zones[existingIdx] = {
        ...zones[existingIdx],
        name: zoneLevel.name || zoneLevel.internalName || zones[existingIdx].name,
        linkedLevelId: zoneLevel.id,
      };
      return { ...level, zones };
    }
    const newId = crypto.randomUUID();
    zones.push({
      id: newId,
      name: zoneLevel.name || zoneLevel.internalName || `Zone ${zones.length + 1}`,
      linkedLevelId: zoneLevel.id,
      points: defaultZonePolygonPoints(logicalW, logicalH),
      color: '#3b82f6',
      opacity: 0.2,
    });
    return { ...level, zones };
  });
}

/** Remove polygons on any floor that linked to the deleted zone-level. */
export function removeLinkedZonePolygons(levels, zoneLevelId) {
  if (zoneLevelId == null) return levels || [];
  return (levels || []).map((level) => {
    if (isZoneLevel(level)) return level;
    const zones = Array.isArray(level.zones) ? level.zones : [];
    const next = zones.filter((z) => String(z?.linkedLevelId) !== String(zoneLevelId));
    if (next.length === zones.length) return level;
    return { ...level, zones: next };
  });
}

/**
 * GarageLevels / FLICameras Level cell for a camera.
 * When traffic targets a linked zone (or a zone-level), use that zone-level's sheet name.
 */
export function resolveCameraSheetLevelName(device, placementLevel, siteOrLevels) {
  const levels = Array.isArray(siteOrLevels)
    ? siteOrLevels
    : (siteOrLevels?.levels || []);
  const flow = device?.trafficFlow;
  const placementName = placementLevel?.internalName || placementLevel?.name || '';

  if (flow?.zone != null && String(flow.zone) !== '') {
    const parent = levels.find((l) => String(l.id) === String(flow.level))
      || placementLevel
      || null;
    const zone = (parent?.zones || []).find((z) => String(z.id) === String(flow.zone));
    if (zone?.linkedLevelId != null) {
      const zoneLevel = levels.find((l) => String(l.id) === String(zone.linkedLevelId));
      if (zoneLevel) return zoneSheetLevelName(zoneLevel, levels) || placementName;
    }
    if (zone?.name) {
      const parentName = String(parent?.name || parent?.internalName || '').trim();
      if (parentName && !String(zone.name).toLowerCase().startsWith(`${parentName.toLowerCase()} `)) {
        return `${parentName} ${zone.name}`;
      }
      return zone.name;
    }
  }

  if (flow?.level != null && String(flow.level) !== '') {
    const target = levels.find((l) => String(l.id) === String(flow.level));
    if (target && isZoneLevel(target)) {
      return zoneSheetLevelName(target, levels) || placementName;
    }
  }

  return placementName;
}
