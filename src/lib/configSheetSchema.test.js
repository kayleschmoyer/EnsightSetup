import { describe, expect, it } from 'vitest';
import {
  buildDisplayLevelSheetRows,
  buildDisplayControllerSheetRow,
  buildGarageLevelSheetRow,
  buildNetworkingSheetRow,
  ensureDeviceSensorGroup,
  sensorGroupIdForDevice,
  applyServersToGarages,
  mergeGaragesPreferNetworkingServers,
  pruneUnusedSensorGroups,
  pruneUnusedDisplayGroups,
} from './configSheetSchema';

describe('buildDisplayLevelSheetRows', () => {
  const garages = [{
    id: 1,
    name: 'East Central',
    levels: [
      { id: 1, name: 'Level B1', config: { internalName: 'Level B1' } },
      { id: 2, name: 'Level P1', config: { internalName: 'Level P1' } },
      { id: 3, name: 'Level P2', config: { internalName: 'Level P2' } },
    ],
  }];

  it('exports comma-separated levels for multi-level signs', () => {
    const rows = buildDisplayLevelSheetRows({
      type: 'sign-led',
      friendlyName: 'B2 Ramp Sign',
      displayGarageId: 1,
      displayLevelIds: [1, 2, 3],
    }, garages);

    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe('Level B1,Level P1,Level P2');
  });

  it('exports a single level cell for one level', () => {
    const rows = buildDisplayLevelSheetRows({
      type: 'sign-led',
      friendlyName: 'P1 Entry',
      displayGarageId: 1,
      displayLevelIds: [2],
    }, garages);

    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe('Level P1');
    expect(rows[0][4]).toBe('Level P1');
  });

  it('preserves DisplayControllers optional columns', () => {
    const row = buildDisplayControllerSheetRow({
      type: 'sign-led',
      friendlyName: 'B2 Ramp Sign',
      displayMap: 'MapA',
      hardwareType: 'LEDPanel',
      keepLevelCountsSeparate: true,
    }, { displayGroups: [], servers: [] });

    expect(row[8]).toBe('');
    expect(row[9]).toBe('MapA');
    expect(row[10]).toBe('LEDPanel');
    expect(row[11]).toBe('TRUE');
  });

  it('preserves an explicit DisplayProtocol value', () => {
    const row = buildDisplayControllerSheetRow({
      type: 'sign-led',
      friendlyName: 'B2 Ramp Sign',
      displayProtocol: 'SIGNALTECHDISPLAY',
    }, { displayGroups: [], servers: [] });

    expect(row[8]).toBe('SIGNALTECHDISPLAY');
  });
});

describe('buildGarageLevelSheetRow', () => {
  it('uses level.config.levelType when present', () => {
    const row = buildGarageLevelSheetRow(
      { name: 'Site', internalName: 'Site' },
      { name: 'L1', internalName: 'L1', totalSpots: 50, config: { levelType: 'LPR' } },
      1,
    );
    expect(row[4]).toBe('LPR');
  });

  it('defaults LevelType to FLI', () => {
    const row = buildGarageLevelSheetRow(
      { name: 'Site', internalName: 'Site' },
      { name: 'L1', internalName: 'L1', totalSpots: 50, config: {} },
      1,
    );
    expect(row[4]).toBe('FLI');
  });

  it('writes FLI for zone-levels even when config still says Zone', () => {
    const row = buildGarageLevelSheetRow(
      {
        name: 'Site',
        internalName: 'Site',
        levels: [
          { id: 1, name: 'Level 1', internalName: 'Level 1' },
          {
            id: 10,
            name: 'Zone 1',
            internalName: 'Zone 1',
            isZone: true,
            parentLevelId: 1,
            totalSpots: 0,
            config: { levelType: 'Zone' },
          },
        ],
      },
      {
        id: 10,
        name: 'Zone 1',
        internalName: 'Zone 1',
        isZone: true,
        parentLevelId: 1,
        totalSpots: 0,
        config: { levelType: 'Zone' },
      },
      2,
    );
    expect(row[4]).toBe('FLI');
    expect(row[1]).toBe('Level 1 Zone 1');
    expect(row[2]).toBe('Level 1 Zone 1');
  });
});

describe('buildNetworkingSheetRow', () => {
  it('maps LevelSelector server fields onto Networking columns', () => {
    const row = buildNetworkingSheetRow({
      name: 'EPIC-01',
      type: 'epic',
      ports: [{ ip: '10.0.0.5', mac: 'AA:BB', dhcp: false }],
      splashtopUser: 'Administrator',
      notes: 'Primary',
    });
    expect(row[1]).toBe('epic');
    expect(row[2]).toBe('EPIC-01');
    expect(row[6]).toBe('10.0.0.5');
    expect(row[7]).toBe('Static');
    expect(row[8]).toBe('AA:BB');
    expect(row[12]).toBe('Administrator');
    expect(row[14]).toBe('Primary');
  });
});

describe('ensureDeviceSensorGroup', () => {
  it('creates a protocol group and assigns configSensorGroupId', () => {
    const garage = {
      id: 1,
      name: 'Site',
      sensorGroups: [],
      levels: [{ id: 1, name: 'L1', devices: [] }],
    };
    const device = { id: 9, type: 'sensor-nwave', name: '1.1NW' };
    const { device: nextDevice, garage: nextGarage } = ensureDeviceSensorGroup(
      garage,
      garage.levels[0],
      device,
    );

    expect(nextDevice.configSensorGroupId).toBe(1);
    expect(nextGarage.sensorGroups).toHaveLength(1);
    expect(nextGarage.sensorGroups[0].sensorProtocol).toBe('NWAVE');
    expect(nextGarage.sensorGroups[0].groupId).toBe('NWAVE');
    expect(sensorGroupIdForDevice(nextDevice, nextGarage.sensorGroups)).toBe('NWAVE');
    expect(nextGarage.levels[0].devices[0].name).toBe('1.1NW');
  });

  it('reuses an existing group with the same protocol', () => {
    const garage = {
      id: 1,
      name: 'Site',
      sensorGroups: [{
        id: 4,
        groupId: 'ExistingNW',
        sensorProtocol: 'NWAVE',
        controllerAddress: '',
        controllerKey: '',
        parentLevel: '',
      }],
      levels: [{ id: 1, name: 'L1', devices: [] }],
    };
    const { device: nextDevice, garage: nextGarage } = ensureDeviceSensorGroup(
      garage,
      garage.levels[0],
      { id: 2, type: 'sensor-nwave', name: '1.2NW' },
    );

    expect(nextDevice.configSensorGroupId).toBe(4);
    expect(nextGarage.sensorGroups).toHaveLength(1);
    expect(sensorGroupIdForDevice(nextDevice, nextGarage.sensorGroups)).toBe('ExistingNW');
  });
});

describe('networking servers merge', () => {
  it('applies Networking servers onto every garage', () => {
    const servers = [{ id: 1, name: 'SRV-1', type: 'other', ports: [] }];
    const next = applyServersToGarages(
      [{ id: 1, name: 'G1', servers: [] }, { id: 2, name: 'G2', servers: [{ id: 9, name: 'old' }] }],
      servers,
    );
    expect(next[0].servers[0].name).toBe('SRV-1');
    expect(next[1].servers[0].name).toBe('SRV-1');
  });

  it('prefers tab servers over empty SetupJson servers', () => {
    const setup = [{ id: 1, name: 'G1', servers: [], levels: [] }];
    const tabs = [{ id: 1, name: 'G1', servers: [{ id: 1, name: 'FromNet', type: 'other', ports: [] }] }];
    const merged = mergeGaragesPreferNetworkingServers(setup, tabs);
    expect(merged[0].servers[0].name).toBe('FromNet');
  });

  it('keeps SetupJson servers when tabs have none', () => {
    const setup = [{ id: 1, name: 'G1', servers: [{ id: 1, name: 'FromSetup' }] }];
    const tabs = [{ id: 1, name: 'G1', servers: [] }];
    expect(mergeGaragesPreferNetworkingServers(setup, tabs)[0].servers[0].name).toBe('FromSetup');
  });
});

describe('pruneUnused groups', () => {
  it('removes sensor groups no device references', () => {
    const garage = {
      sensorGroups: [
        { id: 1, groupId: 'Keep' },
        { id: 2, groupId: 'Orphan' },
      ],
      levels: [{
        id: 1,
        devices: [{ id: 10, type: 'sensor-nwave', configSensorGroupId: 1 }],
      }],
    };
    const next = pruneUnusedSensorGroups(garage);
    expect(next.sensorGroups).toEqual([{ id: 1, groupId: 'Keep' }]);
  });

  it('removes display groups no sign references', () => {
    const garage = {
      displayGroups: [
        { id: 1, name: 'Keep' },
        { id: 2, name: 'Orphan' },
      ],
      levels: [{
        id: 1,
        devices: [{ id: 10, type: 'sign-led', displayGroupId: 1 }],
      }],
    };
    const next = pruneUnusedDisplayGroups(garage);
    expect(next.displayGroups).toEqual([{ id: 1, name: 'Keep' }]);
  });
});
