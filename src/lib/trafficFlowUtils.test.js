import { describe, expect, it } from 'vitest';
import {
  flowDestinationMatchesLevel,
  flowDestinationOptions,
  flowTargetKey,
  flowTargetLabel,
  flowTargetOptions,
  levelsHaveZones,
  normalizeFlowDestinations,
  parseFlowTargetKey,
  resolveFlowTargetKey,
  virtualCountersForLevel,
} from './trafficFlowUtils';

const LEVELS = [
  {
    id: 1,
    name: 'Level 1',
    zones: [
      { id: 3, name: 'Ramp Zone' },
      { id: 4, name: 'Retail Zone' },
    ],
  },
  { id: 2, name: 'Level 2', zones: [] },
  { id: 5, name: 'Roof' },
];

describe('flow target keys', () => {
  it('encodes a whole level and a zone on a level', () => {
    expect(flowTargetKey(1, '')).toBe('1');
    expect(flowTargetKey(1, null)).toBe('1');
    expect(flowTargetKey(1, 3)).toBe('1:3');
    expect(flowTargetKey('', 3)).toBe('');
  });

  it('round-trips through parse', () => {
    expect(parseFlowTargetKey('1')).toEqual({ levelId: '1', zoneId: '' });
    expect(parseFlowTargetKey('1:3')).toEqual({ levelId: '1', zoneId: '3' });
    expect(parseFlowTargetKey('')).toEqual({ levelId: '', zoneId: '' });
    expect(parseFlowTargetKey(undefined)).toEqual({ levelId: '', zoneId: '' });
  });
});

describe('flowTargetOptions', () => {
  it('lists each level followed by its zones', () => {
    expect(flowTargetOptions(LEVELS)).toEqual([
      { key: '1', levelId: '1', zoneId: '', label: 'Level 1', isZone: false },
      { key: '1:3', levelId: '1', zoneId: '3', label: 'Ramp Zone', isZone: true },
      { key: '1:4', levelId: '1', zoneId: '4', label: 'Retail Zone', isZone: true },
      { key: '2', levelId: '2', zoneId: '', label: 'Level 2', isZone: false },
      { key: '5', levelId: '5', zoneId: '', label: 'Roof', isZone: false },
    ]);
  });

  it('tolerates missing levels and unnamed entries', () => {
    expect(flowTargetOptions(null)).toEqual([]);
    expect(flowTargetOptions([{ id: 7 }, { name: 'no id' }])).toEqual([
      { key: '7', levelId: '7', zoneId: '', label: 'Level 7', isZone: false },
    ]);
  });
});

describe('levelsHaveZones', () => {
  it('detects whether any level has a zone', () => {
    expect(levelsHaveZones(LEVELS)).toBe(true);
    expect(levelsHaveZones([{ id: 1, zones: [] }, { id: 2 }])).toBe(false);
    expect(levelsHaveZones(null)).toBe(false);
  });
});

describe('resolveFlowTargetKey', () => {
  it('keeps a zone that still exists', () => {
    expect(resolveFlowTargetKey(LEVELS, '1', 3)).toBe('1:3');
    expect(resolveFlowTargetKey(LEVELS, 1, '3')).toBe('1:3');
  });

  it('falls back to the level when the zone was deleted', () => {
    expect(resolveFlowTargetKey(LEVELS, '1', 99)).toBe('1');
  });

  it('returns empty for an unknown level', () => {
    expect(resolveFlowTargetKey(LEVELS, '404', 3)).toBe('');
    expect(resolveFlowTargetKey(LEVELS, '', '')).toBe('');
  });
});

describe('flowTargetLabel', () => {
  it('names the level, or the level and zone', () => {
    expect(flowTargetLabel(LEVELS, '1', '')).toBe('Level 1');
    expect(flowTargetLabel(LEVELS, '1', 3)).toBe('Level 1 › Ramp Zone');
  });

  it('drops a deleted zone rather than showing a dangling reference', () => {
    expect(flowTargetLabel(LEVELS, '1', 99)).toBe('Level 1');
  });

  it('uses the fallback for an unknown level', () => {
    expect(flowTargetLabel(LEVELS, '404', '', 'this level')).toBe('this level');
  });
});

describe('normalizeFlowDestinations', () => {
  it('accepts legacy bare level ids and new zone keys alike', () => {
    expect(normalizeFlowDestinations([2, 5])).toEqual(['2', '5']);
    expect(normalizeFlowDestinations(['1:4', 2])).toEqual(['1:4', '2']);
  });

  it('drops empties and duplicates', () => {
    expect(normalizeFlowDestinations([2, '2', null, '', undefined])).toEqual(['2']);
    expect(normalizeFlowDestinations(null)).toEqual([]);
  });
});

describe('flowDestinationMatchesLevel', () => {
  it('matches whole-level and zone destinations on that level', () => {
    expect(flowDestinationMatchesLevel('1', 1)).toBe(true);
    expect(flowDestinationMatchesLevel('1:4', 1)).toBe(true);
    expect(flowDestinationMatchesLevel('1:4', 2)).toBe(false);
    expect(flowDestinationMatchesLevel('1', null)).toBe(false);
  });
});

describe('flowDestinationOptions', () => {
  it('excludes only the primary target, keeping sibling zones on that level', () => {
    const keys = flowDestinationOptions(LEVELS, '1:3').map(o => o.key);
    expect(keys).toEqual(['1', '1:4', '2', '5']);
    // The point of the ticket: Zone 1 → Zone 2 on the same level is selectable.
    expect(keys).toContain('1:4');
  });

  it('excludes the whole level when that is the primary target', () => {
    expect(flowDestinationOptions(LEVELS, '1').map(o => o.key)).toEqual(['1:3', '1:4', '2', '5']);
  });
});

describe('virtualCountersForLevel with zone targets', () => {
  const zoneLevels = (trafficFlow) => ([
    {
      id: 1,
      name: 'Level 1',
      zones: [{ id: 3, name: 'Ramp Zone' }, { id: 4, name: 'Retail Zone' }],
      devices: [],
    },
    {
      id: 2,
      name: 'Level 2',
      devices: [{ id: 'cam-a', type: 'cam-fli', trafficFlow }],
    },
  ]);

  it('still counts a zone-targeted camera for its level', () => {
    const counters = virtualCountersForLevel(zoneLevels({ direction: 'out', level: '1', zone: 3 }), 1);
    expect(counters).toHaveLength(1);
    expect(counters[0].device.id).toBe('cam-a');
    expect(counters[0].direction).toBe('out');
    expect(counters[0].role).toBe('primary');
    expect(counters[0].targetLabel).toBe('Level 1 › Ramp Zone');
  });

  it('counts a zone destination with the inverse direction', () => {
    const counters = virtualCountersForLevel(
      zoneLevels({ direction: 'out', level: '2', multiLevel: true, destinations: ['1:4'] }),
      1,
    );
    expect(counters).toHaveLength(1);
    expect(counters[0].direction).toBe('in');
    expect(counters[0].role).toBe('opposite');
    expect(counters[0].targetLabel).toBe('Level 1 › Retail Zone');
  });

  it('nets to zero for a camera pairing two zones on the same level', () => {
    const counters = virtualCountersForLevel(
      zoneLevels({ direction: 'out', level: '1', zone: 3, multiLevel: true, destinations: ['1:4'] }),
      1,
    );
    // Moving between zones doesn't change level occupancy, so both halves land
    // on this level with opposite directions — and carry distinct roles.
    expect(counters).toHaveLength(2);
    expect(counters.map(c => c.direction).sort()).toEqual(['in', 'out']);
    expect(counters.map(c => c.role).sort()).toEqual(['opposite', 'primary']);
  });

  it('keeps counting legacy bare level-id destinations', () => {
    const counters = virtualCountersForLevel(
      zoneLevels({ direction: 'in', level: '2', multiLevel: true, destinations: [1] }),
      1,
    );
    expect(counters).toHaveLength(1);
    expect(counters[0].direction).toBe('out');
    expect(counters[0].targetLabel).toBe('Level 1');
  });
});
