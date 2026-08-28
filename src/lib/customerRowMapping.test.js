import { describe, it, expect } from 'vitest';
import { splitLegacyDevice, dbDeviceToLegacy } from './customerRowMapping';

/**
 * Reassemble a PostgREST-nested-select row from splitLegacyDevice's output,
 * so these tests exercise the exact write shape -> exact read shape round
 * trip CustomerRepository actually performs.
 */
function toRow(split) {
  const insertRows = split.signInserts.map((i) => ({
    ...i.row,
    sign_insert_levels: i.levels,
  }));
  return {
    ...split.device,
    camera_details: split.cameraDetails,
    camera_streams: split.streams,
    camera_traffic_destinations: split.trafficDestinations,
    sign_details: split.signDetails,
    sign_display_levels: split.signDisplayLevels,
    sign_inserts: insertRows,
    sensor_details: split.sensorDetails,
    sensor_units: split.sensorUnits,
    device_photos: split.photos,
  };
}

const LEVEL_ID = 'level-1';
const ZONE_ID = 'zone-1';
const OTHER_LEVEL_ID = 'level-2';
const zoneIdSet = new Set([ZONE_ID]);

describe('camera round-trip', () => {
  it('preserves dual-lens streams, traffic flow, and a destination targeting a zone', () => {
    const device = {
      id: 'cam-1', type: 'cam-fli', name: '1.1F', x: 10, y: 20, rotation: 90,
      serverId: 'srv-1', mdfIdfLocationId: 'mdf-1', friendlyName: 'North Entry',
      dhcp: false, disabled: false, pendingPlacement: false, iconSize: 12,
      hardwareType: 'dual-lens', color: '#abc123', coneSize: 55,
      isEntryExitCamera: false, dependentCameraName: '1.2F',
      stream1: { ipAddress: '10.0.0.1', port: '554', externalUrl: 'rtsp://a', streamType: 'cam-fli', rotation: 5, coneSize: 40, color: '#111' },
      stream2: { ipAddress: '10.0.0.2', port: '554', externalUrl: 'rtsp://b', streamType: 'cam-lpr' },
      trafficFlow: {
        direction: 'in', level: LEVEL_ID, zone: ZONE_ID, multiLevel: true,
        destinations: [`${OTHER_LEVEL_ID}:${ZONE_ID}`, OTHER_LEVEL_ID],
        comingFrom: 'Street',
      },
      viewImage: 'customer/garage/level/cam-1/0-123.jpg',
    };

    const split = splitLegacyDevice(device, LEVEL_ID, zoneIdSet);
    const back = dbDeviceToLegacy(toRow(split));

    expect(back.hardwareType).toBe('dual-lens');
    expect(back.color).toBe('#abc123');
    expect(back.coneSize).toBe(55);
    expect(back.isEntryExitCamera).toBe(false);
    expect(back.dependentCameraName).toBe('1.2F');
    expect(back.stream1).toMatchObject({ ipAddress: '10.0.0.1', port: '554', externalUrl: 'rtsp://a', rotation: 5, coneSize: 40, color: '#111' });
    expect(back.stream2).toMatchObject({ ipAddress: '10.0.0.2', externalUrl: 'rtsp://b', streamType: 'cam-lpr' });
    // Legacy flat mirrors reconstructed from stream1.
    expect(back.ipAddress).toBe('10.0.0.1');
    expect(back.rtspUrl).toBe('rtsp://a');
    expect(back.trafficFlow).toMatchObject({
      direction: 'in', level: LEVEL_ID, zone: ZONE_ID, multiLevel: true, comingFrom: 'Street',
    });
    expect(back.trafficFlow.destinations.sort()).toEqual([OTHER_LEVEL_ID, `${OTHER_LEVEL_ID}:${ZONE_ID}`].sort());
    expect(back.viewImage).toBe('customer/garage/level/cam-1/0-123.jpg');
    expect(back.serverId).toBe('srv-1');
    expect(back.mdfIdfLocationId).toBe('mdf-1');
    expect(back.friendlyName).toBe('North Entry');
  });

  it('synthesizes stream1 from legacy flat fields when stream1 was never structured', () => {
    const device = {
      id: 'cam-2', type: 'cam-fli', name: 'Legacy Cam',
      ipAddress: '192.168.1.5', port: '80', rtspUrl: 'rtsp://legacy',
    };
    const split = splitLegacyDevice(device, LEVEL_ID, zoneIdSet);
    const back = dbDeviceToLegacy(toRow(split));
    expect(back.stream1).toMatchObject({ ipAddress: '192.168.1.5', port: '80', externalUrl: 'rtsp://legacy' });
  });

  it('single-lens camera has no stream2 row', () => {
    const device = { id: 'cam-3', type: 'cam-lpr', name: 'Single', stream1: { ipAddress: '1.1.1.1' } };
    const split = splitLegacyDevice(device, LEVEL_ID, zoneIdSet);
    expect(split.streams).toHaveLength(1);
    const back = dbDeviceToLegacy(toRow(split));
    expect(back.stream2).toBeUndefined();
  });
});

describe('sign round-trip', () => {
  it('preserves a single-controller sign (no inserts) with a floor + zone display selection', () => {
    const device = {
      id: 'sign-1', type: 'sign-static', name: 'S1.1', x: 1, y: 2,
      controllerName: 'Ctrl', visibleName: 'Visible', displayProtocol: 'TCP/IP',
      displayGroupId: 'dg-1', displaySiteId: 'garage-1', displayLevelAll: false,
      displayLevelIds: [LEVEL_ID, ZONE_ID],
      positionName: 'Row A', keepLevelCountsSeparate: true,
      serialAddress: 'COM1', ipAddress: '10.1.1.1', port: '80', macAddress: '00:11:22:33:44:55',
      sided: 'dual', boldSides: ['top', 'left'], signLogicalKey: 's1.1',
    };
    const split = splitLegacyDevice(device, LEVEL_ID, zoneIdSet);
    expect(split.signDetails.uses_inserts).toBe(false);
    const back = dbDeviceToLegacy(toRow(split));

    expect(back.inserts).toBeUndefined();
    expect(back.controllerName).toBe('Ctrl');
    expect(back.displayProtocol).toBe('TCP/IP');
    expect(back.displayGroupId).toBe('dg-1');
    expect(back.displaySiteId).toBe('garage-1');
    expect(back.displayLevelIds.sort()).toEqual([LEVEL_ID, ZONE_ID].sort());
    expect(back.positionName).toBe('Row A');
    expect(back.keepLevelCountsSeparate).toBe(true);
    expect(back.serialAddress).toBe('COM1');
    expect(back.macAddress).toBe('00:11:22:33:44:55');
    expect(back.sided).toBe('dual');
    expect(back.boldSides).toEqual(['top', 'left']);
    expect(back.signLogicalKey).toBe('s1.1');
  });

  it('preserves a monument sign with inserts, including the empty-inserts state and each insert own level selection', () => {
    const device = {
      id: 'sign-2', type: 'sign-designable', name: 'S2.1',
      inserts: [
        { id: 'ins-a', displayName: 'A', serialAddress: '1', hasEthernet: true, displayLevelAll: false, displayLevelIds: [LEVEL_ID] },
        { id: 'ins-b', displayName: 'B', serialAddress: '2', hasEthernet: false, displayLevelAll: true, displayLevelIds: [] },
      ],
    };
    const split = splitLegacyDevice(device, LEVEL_ID, zoneIdSet);
    expect(split.signDetails.uses_inserts).toBe(true);
    const back = dbDeviceToLegacy(toRow(split));

    expect(back.inserts).toHaveLength(2);
    const [a, b] = back.inserts;
    expect(a).toMatchObject({ id: 'ins-a', displayName: 'A', hasEthernet: true, displayLevelAll: false, displayLevelIds: [LEVEL_ID] });
    expect(b).toMatchObject({ id: 'ins-b', displayName: 'B', hasEthernet: false, displayLevelAll: true, displayLevelIds: [] });
  });

  it('distinguishes "no inserts field" from "inserts: []" (monument mode, none added yet)', () => {
    const noInserts = splitLegacyDevice({ id: 'sign-3', type: 'sign-led', name: 'X' }, LEVEL_ID, zoneIdSet);
    const emptyInserts = splitLegacyDevice({ id: 'sign-4', type: 'sign-led', name: 'Y', inserts: [] }, LEVEL_ID, zoneIdSet);
    expect(noInserts.signDetails.uses_inserts).toBe(false);
    expect(emptyInserts.signDetails.uses_inserts).toBe(true);

    const backEmpty = dbDeviceToLegacy(toRow(emptyInserts));
    expect(Array.isArray(backEmpty.inserts)).toBe(true);
    expect(backEmpty.inserts).toHaveLength(0);
  });

  it('preserves sign photos in order', () => {
    const device = { id: 'sign-5', type: 'sign-led', name: 'Z', signImages: ['a.jpg', 'b.jpg', 'c.jpg'] };
    const split = splitLegacyDevice(device, LEVEL_ID, zoneIdSet);
    const back = dbDeviceToLegacy(toRow(split));
    expect(back.signImages).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });
});

describe('sensor round-trip', () => {
  it('preserves protocol, group, count, api key', () => {
    const device = {
      id: 'sen-1', type: 'sensor-nwave', name: 'SEN-1',
      sensorGroup: 'sensor-nwave', configSensorGroupId: 'sg-1', sensorCount: 3, apiKey: 'abc123',
    };
    const split = splitLegacyDevice(device, LEVEL_ID, zoneIdSet);
    const back = dbDeviceToLegacy(toRow(split));
    expect(back.sensorGroup).toBe('sensor-nwave');
    expect(back.configSensorGroupId).toBe('sg-1');
    expect(back.sensorCount).toBe(3);
    expect(back.apiKey).toBe('abc123');
    expect(back.sensors).toBeUndefined();
  });

  it('preserves legacy multi-unit sensors array when present', () => {
    const device = {
      id: 'sen-2', type: 'sensor-proco', name: 'SEN-2',
      sensors: [{ sensorName: 'A', sensorId: '1' }, { sensorName: 'B', sensorId: '2' }],
    };
    const split = splitLegacyDevice(device, LEVEL_ID, zoneIdSet);
    const back = dbDeviceToLegacy(toRow(split));
    expect(back.sensors).toEqual([{ sensorName: 'A', sensorId: '1' }, { sensorName: 'B', sensorId: '2' }]);
  });

  it('defaults sensorGroup to type when neither sensorGroup nor stored protocol is set', () => {
    const split = splitLegacyDevice({ id: 'sen-3', type: 'sensor-ensight', name: 'SEN-3' }, LEVEL_ID, zoneIdSet);
    const back = dbDeviceToLegacy(toRow(split));
    expect(back.sensorGroup).toBe('sensor-ensight');
  });
});

describe('shared device fields', () => {
  it('round-trips assignment, placement, and status fields for every family', () => {
    const device = {
      id: 'dev-1', type: 'cam-fli', name: 'D1',
      serverId: 'srv-9', mdfIdfLocationId: 'mdf-9', server: 'Legacy Server Name',
      dhcp: true, disabled: true, disabledReason: 'broken', placementReason: 'awaiting mount',
      pendingPlacement: true, iconSize: 30,
    };
    const split = splitLegacyDevice(device, LEVEL_ID, zoneIdSet);
    const back = dbDeviceToLegacy(toRow(split));
    expect(back).toMatchObject({
      serverId: 'srv-9', mdfIdfLocationId: 'mdf-9', server: 'Legacy Server Name',
      dhcp: true, disabled: true, disabledReason: 'broken', placementReason: 'awaiting mount',
      pendingPlacement: true, iconSize: 30,
    });
  });
});
