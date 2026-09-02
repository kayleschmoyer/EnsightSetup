/**
 * parseExcelFile against a real in-memory workbook — one check per tab that
 * the columns the database needs come out of the parser (the mapper tests in
 * src/lib/importedWorkbookMapping.test.js take it from there to the rows).
 */
import { describe, expect, it } from 'vitest';
import { parseExcelFile, getImportSummary } from './ExcelParserService';
import { buildSampleWorkbookBuffer } from './__fixtures__/sampleWorkbook';

const UUID_RE = /^[0-9a-f-]{36}$/;

function parseSample() {
  return parseExcelFile(buildSampleWorkbookBuffer());
}

function findDevice(parsed, name) {
  for (const site of parsed.sites) {
    for (const level of site.levels) {
      const hit = level.devices.find((d) => d.name === name);
      if (hit) return { device: hit, level, site };
    }
  }
  return null;
}

describe('parseExcelFile (sample workbook)', () => {
  it('reads the Customer tab into rawData.customer', () => {
    const { rawData } = parseSample();
    expect(rawData.customer).toMatchObject({
      FriendlyName: 'Acme Parking', CustomerId: 'acme', Code: 'ACME',
      Address: '1 Main St', City: 'Boston', State: 'MA', Zip: '02101',
      MaintenanceProvider: 'Ensight', EnterpriseSite: 'TRUE', Support24Hour: 'FALSE',
    });
  });

  it('gives every entity a uuid, not a running integer', () => {
    const parsed = parseSample();
    const site = parsed.sites[0];
    expect(site.id).toMatch(UUID_RE);
    for (const level of site.levels) {
      expect(level.id).toMatch(UUID_RE);
      for (const device of level.devices) expect(device.id).toMatch(UUID_RE);
    }
    for (const server of site.servers) expect(server.id).toMatch(UUID_RE);
    for (const group of site.displayGroups) expect(group.id).toMatch(UUID_RE);
    for (const group of site.sensorGroups) expect(group.id).toMatch(UUID_RE);
  });

  it('Networking: keeps the legacy columns the servers table stores', () => {
    const [epic, fli] = parseSample().sites[0].servers;
    expect(epic).toMatchObject({
      name: 'EPIC-01', device: 'EPIC Server', type: 'epic', manufacturer: 'Dell',
      status: 'Active', location: 'Server room', mdfIdfLocation: 'MDF-1',
      ipAddress: '10.0.0.5', ipAssignmentMethod: 'Static', macAddress: 'AA:BB:CC:00:00:05',
      subnet: '255.255.255.0', gateway: '10.0.0.1', dns: '8.8.8.8',
      username: 'admin', password: 'secret', notes: 'Primary host',
      streamAddress: 'https://splashtop.example/epic-01',
      splashtopUser: 'admin', splashtopPassword: 'secret', splashtopUrl: 'https://splashtop.example/epic-01',
    });
    expect(epic.ports[0]).toEqual({ mac: 'AA:BB:CC:00:00:05', ip: '10.0.0.5', dhcp: false });
    expect(fli.ports[0].dhcp).toBe(true);
    expect(fli.type).toBe('fli');
  });

  it('Garages: internal name, visible name and stage, without HTML escaping', () => {
    const parsed = parseExcelFile(buildSampleWorkbookBuffer({
      rows: { Garages: [['North', 'North & South', 'Live']] },
    }));
    expect(parsed.sites[0]).toMatchObject({ internalName: 'North', name: 'North & South', stage: 'Live' });
  });

  it('GarageLevels: every config column survives on level.config', () => {
    const level2 = parseSample().sites[0].levels.find((l) => l.internalName === 'Level 2');
    expect(level2.totalSpots).toBe(200);
    expect(level2.config).toEqual({
      server: 'EPIC-01', levelType: 'FLI', visibleOnPortal: false, maximumOccupancy: 200,
      autoResetCountsEnabled: true, autoResetCountValue: 10, autoResetCountTime: '03:30',
      forceFullVacancyThreshold: 7, vehicleTransitThreshold: 2, vehicleTransitThresholdTTLSeconds: 30,
      showFullMessage: false, showFullMessageRed: false, portalDisplayOrdinal: 3, signDisplayOrdinal: 3,
      portalRendering: 'Grid', vehicleRolesAllowed: 'Staff',
    });
  });

  it('DisplayControllers: reads HardwareType (the template header) and the group', () => {
    const parsed = parseSample();
    const { device } = findDevice(parsed, 'S1.1');
    expect(device).toMatchObject({
      type: 'sign-static', controllerName: 'CTRL-1', visibleName: 'Entrance Sign',
      displayGroupName: 'Group1', server: 'EPIC-01', ipAddress: '10.0.0.50', port: '5000',
      serialAddress: '1', displayProtocol: 'SIGNALTECHDISPLAY', displayMap: 'MAP1',
      hardwareType: 'LED', keepLevelCountsSeparate: false, positionName: 'Pos A',
    });
    expect(device.displayGroupId).toBe(parsed.sites[0].displayGroups[0].id);
  });

  it('DisplayControllers: two rows sharing controller + IP become one monument with inserts', () => {
    const parsed = parseSample();
    const monument = parsed.sites[0].levels
      .flatMap((l) => l.devices)
      .find((d) => Array.isArray(d.inserts));
    expect(monument).toBeTruthy();
    expect(monument.inserts.map((i) => i.displayName)).toEqual(['M1-A', 'M1-B']);
    expect(monument.inserts[1].displayLevelAll).toBe(true);
    expect(monument.hardwareType).toBe('STATIC');
  });

  it('Cameras: stream 1 is structured and status drives disabled', () => {
    const parsed = parseSample();
    const entrance = findDevice(parsed, 'CAM1.1F').device;
    expect(entrance).toMatchObject({
      type: 'cam-fli', friendlyName: 'Entrance Cam', disabled: false, resolution: '1080p',
      server: 'EPIC-01', hardwareType: 'bullet', isEntryExitCamera: true,
      trafficFlow: { direction: 'in' },
    });
    expect(entrance.stream1).toEqual({
      ipAddress: '10.0.0.101', port: '554', externalUrl: 'rtsp://10.0.0.101/live', streamType: 'cam-fli',
    });
    const lpr = findDevice(parsed, 'CAM2.1L').device;
    expect(lpr).toMatchObject({ type: 'cam-lpr', disabled: true, trafficFlow: { direction: 'out' } });
    const zoneCam = findDevice(parsed, 'CAMZ.1F');
    expect(zoneCam.level.internalName).toBe('Level 1 Zone A');
    expect(zoneCam.device.dependentCameraName).toBe('CAM1.1F');
  });

  it('SensorGroups/Sensors: group mirrors Garage/Level and the device carries units', () => {
    const parsed = parseSample();
    const group = parsed.sites[0].sensorGroups[0];
    expect(group).toMatchObject({
      groupId: 'G1', controllerAddress: 'http://controller.local', controllerKey: 'key-1',
      sensorProtocol: 'NWAVE', garage: 'North', level: 'Level 2', parentLevel: 'Level 2',
    });
    const { device, level } = findDevice(parsed, 'SensorGroup-G1');
    expect(level.internalName).toBe('Level 2');
    expect(device).toMatchObject({ type: 'sensor-nwave', sensorGroup: 'NWAVE', configSensorGroupId: group.id, sensorCount: 2 });
    expect(device.sensors).toEqual([
      { sensorName: 'SENS-1', sensorId: 'id-1', parkingType: 'Standard', tempParkingTimeInMinutes: 30 },
      { sensorName: 'SENS-2', sensorId: 'id-2', parkingType: 'Temp', tempParkingTimeInMinutes: 0 },
    ]);
  });

  it('DisplaySchedules: rows are kept raw for the mapper', () => {
    const { rawData } = parseSample();
    expect(rawData.displaySchedules).toHaveLength(1);
    expect(rawData.displaySchedules[0]).toMatchObject({ DisplayName: 'S1.1', StartTime: '06:00', Garage2: 'North' });
  });

  it('summarises the workbook', () => {
    const parsed = parseSample();
    const summary = getImportSummary(parsed);
    expect(summary.totalSites).toBe(1);
    expect(summary.totalLevels).toBe(3);
    expect(summary.skippedDisplayLevelRows).toBe(0);
  });
});
