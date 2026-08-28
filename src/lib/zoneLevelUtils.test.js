import { describe, expect, it } from 'vitest';
import {
  ensureLinkedZonePolygon,
  isDuplicateZoneName,
  isZoneLevel,
  nextZoneLevelName,
  resolveCameraSheetLevelName,
  zoneSheetLevelName,
  ZONE_LEVEL_TYPE,
} from './zoneLevelUtils';

describe('zoneLevelUtils', () => {
  it('detects Zone LevelType', () => {
    expect(isZoneLevel({ config: { levelType: ZONE_LEVEL_TYPE } })).toBe(true);
    expect(isZoneLevel({ config: { levelType: 'FLI' } })).toBe(false);
    expect(isZoneLevel({ isZone: true, config: { levelType: 'FLI' } })).toBe(true);
  });

  it('auto-names Zone N under a parent', () => {
    const parent = { id: 1, name: 'Level 1' };
    const levels = [
      parent,
      { id: 10, name: 'Zone 1', parentLevelId: 1, isZone: true },
    ];
    expect(nextZoneLevelName(parent, levels)).toBe('Zone 2');
  });

  it('counts legacy "Level 1 Zone N" names when auto-numbering', () => {
    const parent = { id: 1, name: 'Level 1' };
    const levels = [
      parent,
      { id: 10, name: 'Level 1 Zone 1', parentLevelId: 1, isZone: true },
    ];
    expect(nextZoneLevelName(parent, levels)).toBe('Zone 2');
  });

  it('composes sheet names as Parent + zone name', () => {
    const levels = [
      { id: 1, name: 'Level 1', internalName: 'Level 1' },
      { id: 10, name: 'Zone 1', isZone: true, parentLevelId: 1 },
    ];
    expect(zoneSheetLevelName(levels[1], levels)).toBe('Level 1 Zone 1');
    expect(zoneSheetLevelName({ id: 11, name: 'Retail', isZone: true, parentLevelId: 1 }, levels))
      .toBe('Level 1 Retail');
  });

  it('links a polygon on the parent floor', () => {
    const levels = [{ id: 1, name: 'Level 1', zones: [] }];
    const zoneLevel = { id: 10, name: 'Zone 1' };
    const next = ensureLinkedZonePolygon(levels, zoneLevel, 1);
    expect(next[0].zones).toHaveLength(1);
    expect(next[0].zones[0].linkedLevelId).toBe(10);
    expect(next[0].zones[0].name).toBe('Zone 1');
  });

  it('writes linked zone-level sheet name to FLICameras Level', () => {
    const placement = { id: 1, name: 'Level 1', internalName: 'Level 1' };
    const garage = {
      levels: [
        {
          id: 1,
          name: 'Level 1',
          internalName: 'Level 1',
          zones: [{ id: 5, name: 'Zone 1', linkedLevelId: 10 }],
        },
        {
          id: 10,
          name: 'Zone 1',
          internalName: 'Zone 1',
          parentLevelId: 1,
          isZone: true,
          config: { levelType: 'FLI' },
        },
      ],
    };
    const device = {
      trafficFlow: { direction: 'out', level: 1, zone: 5 },
    };
    expect(resolveCameraSheetLevelName(device, placement, garage)).toBe('Level 1 Zone 1');
  });

  it('falls back to placement level when flow has no zone', () => {
    const placement = { id: 1, name: 'Level 1', internalName: 'Level 1' };
    expect(resolveCameraSheetLevelName({ trafficFlow: { direction: 'in' } }, placement, { levels: [placement] }))
      .toBe('Level 1');
  });

  describe('isDuplicateZoneName', () => {
    const levels = [
      { id: 1, name: 'Level 1' },
      { id: 10, name: 'Zone 3', parentLevelId: 1, isZone: true },
      { id: 11, name: 'Zone 2', parentLevelId: 2, isZone: true },
    ];

    it('flags a name already used by another zone under the same parent', () => {
      expect(isDuplicateZoneName('Zone 3', 1, levels)).toBe(true);
      expect(isDuplicateZoneName('zone 3', 1, levels)).toBe(true); // case-insensitive
      expect(isDuplicateZoneName('  Zone 3  ', 1, levels)).toBe(true); // trims whitespace
    });

    it('allows the same name under a different parent', () => {
      expect(isDuplicateZoneName('Zone 2', 1, levels)).toBe(false);
    });

    it('allows a genuinely new name under the same parent', () => {
      expect(isDuplicateZoneName('Zone 4', 1, levels)).toBe(false);
    });

    it('excludes the zone being edited from its own collision check', () => {
      expect(isDuplicateZoneName('Zone 3', 1, levels, 10)).toBe(false);
    });

    it('ignores an empty name', () => {
      expect(isDuplicateZoneName('', 1, levels)).toBe(false);
      expect(isDuplicateZoneName('   ', 1, levels)).toBe(false);
    });
  });
});
