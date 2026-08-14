import { describe, expect, it } from 'vitest';
import {
  allSignSheetDisplayNames,
  buildDisplayControllerSheetRows,
  buildSignDisplayLevelSheetRows,
  createSignInsert,
  groupDisplayControllersByMonument,
  insertSheetDisplayName,
  signMapLabelLines,
  withEthernetOnInsert,
} from './signInserts';

describe('signInserts', () => {
  const garages = [{
    id: 1,
    name: 'Vanderbilt',
    internalName: 'Vanderbilt',
    levels: [
      { id: 10, name: 'Level 1', internalName: 'Level 1' },
      { id: 20, name: 'Level 2', internalName: 'Level 2' },
      { id: 30, name: 'Level 3', internalName: 'Level 3' },
    ],
  }];

  it('falls back insert DisplayName to map ID when blank', () => {
    const device = { name: 'S1.1', inserts: [createSignInsert({ displayName: '' })] };
    expect(insertSheetDisplayName(device, device.inserts[0])).toBe('S1.1');
  });

  it('builds one DisplayControllers row per insert with shared IP', () => {
    const device = {
      type: 'sign-static',
      name: 'S1.1',
      controllerName: 'ENS-Controller',
      ipAddress: '192.168.1.127',
      port: '10001',
      displayProtocol: 'SIGNALTECHDISPLAY',
      inserts: [
        createSignInsert({ displayName: 'ENS-G1-1.1', serialAddress: '1', hasEthernet: true }),
        createSignInsert({ displayName: 'ENS-G1-1.2', serialAddress: '2' }),
        createSignInsert({ displayName: 'ENS-G1-2.1', serialAddress: '11' }),
      ],
    };

    const rows = buildDisplayControllerSheetRows(device);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.key)).toEqual(['ENS-G1-1.1', 'ENS-G1-1.2', 'ENS-G1-2.1']);
    expect(rows[0].row[1]).toBe('ENS-Controller');
    expect(rows[0].row[5]).toBe('192.168.1.127');
    expect(rows[1].row[5]).toBe('192.168.1.127');
    expect(rows[0].row[7]).toBe('1');
    expect(rows[2].row[7]).toBe('11');
  });

  it('builds DisplayLevels rows per insert', () => {
    const device = {
      type: 'sign-static',
      name: 'S1.1',
      displayGarageId: 1,
      inserts: [
        createSignInsert({
          displayName: 'ENS-G1-1.1',
          displayLevelIds: [10],
        }),
        createSignInsert({
          displayName: 'ENS-G1-1.2',
          displayLevelIds: [20],
        }),
      ],
    };

    const rows = buildSignDisplayLevelSheetRows(device, garages);
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toBe('ENS-G1-1.1');
    expect(rows[0][2]).toBe('Level 1');
    expect(rows[1][0]).toBe('ENS-G1-1.2');
    expect(rows[1][2]).toBe('Level 2');
  });

  it('lists all sheet keys for delete/sync', () => {
    const device = {
      name: 'S1.1',
      inserts: [
        createSignInsert({ displayName: 'A' }),
        createSignInsert({ displayName: 'B' }),
      ],
    };
    expect(allSignSheetDisplayNames(device)).toEqual(['A', 'B']);
  });

  it('map label stacks controller then each insert top to bottom', () => {
    const device = {
      name: 'S1.1',
      controllerName: 'ENS-Controller',
      inserts: [
        createSignInsert({ displayName: 'ENS-G1-1.1' }),
        createSignInsert({ displayName: 'ENS-G1-1.2' }),
      ],
    };
    expect(signMapLabelLines(device)).toEqual([
      'ENS-Controller',
      'ENS-G1-1.1',
      'ENS-G1-1.2',
    ]);
  });

  it('enforces a single ethernet insert', () => {
    const inserts = [
      createSignInsert({ id: 'a', hasEthernet: true }),
      createSignInsert({ id: 'b', hasEthernet: false }),
    ];
    const next = withEthernetOnInsert(inserts, 'b');
    expect(next.find((i) => i.id === 'a').hasEthernet).toBe(false);
    expect(next.find((i) => i.id === 'b').hasEthernet).toBe(true);
  });

  it('groups shared controller+IP into a monument', () => {
    const groups = groupDisplayControllersByMonument([
      { DisplayName: 'ENS-G1-1.1', DisplayControllerName: 'ENS-Controller', IPAddress: '192.168.1.127' },
      { DisplayName: 'ENS-G1-1.2', DisplayControllerName: 'ENS-Controller', IPAddress: '192.168.1.127' },
      { DisplayName: 'Solo', DisplayControllerName: 'Other', IPAddress: '10.0.0.1' },
    ]);
    const monument = groups.find((g) => g.length === 2);
    const solo = groups.find((g) => g.length === 1);
    expect(monument.map((r) => r.DisplayName)).toEqual(['ENS-G1-1.1', 'ENS-G1-1.2']);
    expect(solo[0].DisplayName).toBe('Solo');
  });
});
