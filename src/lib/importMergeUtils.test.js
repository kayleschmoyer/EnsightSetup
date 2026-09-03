/**
 * mergeImportedCustomer — exercised against the real parser + mapper
 * (parseExcelFile → buildCustomerFromWorkbook) on the sample workbook, so
 * these tests catch drift in the device/level/site shape the merge code
 * assumes. Pure: no Drive, no database.
 */
import { describe, expect, it } from 'vitest';
import { buildSampleWorkbookBuffer, SAMPLE_FILE, SAMPLE_ROWS } from '../services/__fixtures__/sampleWorkbook';
import { parseExcelFile } from '../services/ExcelParserService';
import { buildCustomerFromWorkbook } from './importedWorkbookMapping';
import { mergeImportedCustomer } from './importMergeUtils';

function importSample(rows = SAMPLE_ROWS, existingCustomer = null) {
  const parsed = parseExcelFile(buildSampleWorkbookBuffer({ rows }));
  return buildCustomerFromWorkbook(parsed, { file: SAMPLE_FILE, existingCustomer });
}

function findDevice(customer, deviceName) {
  for (const site of customer.sites || []) {
    for (const level of site.levels || []) {
      const device = (level.devices || []).find((d) => d.name === deviceName);
      if (device) return { site, level, device };
    }
  }
  return null;
}

function findLevel(customer, siteInternalName, levelInternalName) {
  const site = customer.sites.find((s) => s.internalName === siteInternalName);
  return site.levels.find((l) => l.internalName === levelInternalName);
}

describe('mergeImportedCustomer', () => {
  it('keeps a placed device\'s position and lets a changed sheet IP win', () => {
    const existingCustomer = importSample();
    const { device: existingCam } = findDevice(existingCustomer, 'CAM1.1F');
    existingCam.x = 123;
    existingCam.y = 456;
    existingCam.rotation = 90;
    existingCam.iconSize = 40;
    existingCam.pendingPlacement = false;

    const changedIpRows = {
      ...SAMPLE_ROWS,
      Cameras: SAMPLE_ROWS.Cameras.map((row) => (row[0] === 'CAM1.1F' ? [row[0], row[1], '10.0.0.201', ...row.slice(3)] : row)),
    };
    const imported = importSample(changedIpRows, existingCustomer);

    const merged = mergeImportedCustomer(existingCustomer, imported);
    const { device: mergedCam } = findDevice(merged, 'CAM1.1F');

    expect(mergedCam.x).toBe(123);
    expect(mergedCam.y).toBe(456);
    expect(mergedCam.rotation).toBe(90);
    expect(mergedCam.iconSize).toBe(40);
    expect(mergedCam.pendingPlacement).toBe(false);
    expect(mergedCam.ipAddress).toBe('10.0.0.201');
    expect(mergedCam.stream1.ipAddress).toBe('10.0.0.201');
  });

  it('keeps a device the sheet no longer lists, and warns about it', () => {
    const existingCustomer = importSample();
    const level = findLevel(existingCustomer, 'North', 'Level 1');
    level.devices.push({
      id: 'app-only-device', name: 'Manual Note Sign', type: 'sign-static', x: 1, y: 2,
    });

    const imported = importSample(SAMPLE_ROWS, existingCustomer);
    const merged = mergeImportedCustomer(existingCustomer, imported);

    const kept = findDevice(merged, 'Manual Note Sign');
    expect(kept).not.toBeNull();
    expect(kept.device.id).toBe('app-only-device');
    expect(merged.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Manual Note Sign')]),
    );
  });

  it('adds a device newly present on the sheet', () => {
    const existingCustomer = importSample();
    const newCameraRows = {
      ...SAMPLE_ROWS,
      Cameras: [...SAMPLE_ROWS.Cameras, ['CAM9.1F', 'New Cam', '10.0.0.109', '554', 'FLI', 'EPIC-01', 'rtsp://10.0.0.109/live', 'Active', '1080p']],
      FLICameras: [...SAMPLE_ROWS.FLICameras, ['CAM9.1F', 'North', 'Level 1', 'IN', 'TRUE', '']],
    };
    const imported = importSample(newCameraRows, existingCustomer);

    const merged = mergeImportedCustomer(existingCustomer, imported);
    const added = findDevice(merged, 'CAM9.1F');
    expect(added).not.toBeNull();
    expect(added.device.ipAddress).toBe('10.0.0.109');
  });

  it('keeps app-only site fields: contacts, non-sheet quick links, MDF/IDF locations', () => {
    const existingCustomer = importSample();
    const site = existingCustomer.sites[0];
    site.contacts = [{ id: 'c1', name: 'Site Manager' }];
    site.mdfIdfLocations = [{ id: 'm1', name: 'MDF-1' }];
    site.quickLinks = [
      { id: 1, name: 'Old Config Sheet', url: 'https://old-sheet.example', icon: 'sheets' },
      { id: 2, name: 'Camera Vendor', url: 'https://vendor.example', icon: 'link' },
    ];

    const imported = importSample(SAMPLE_ROWS, existingCustomer);
    const merged = mergeImportedCustomer(existingCustomer, imported);
    const mergedSite = merged.sites[0];

    expect(mergedSite.contacts).toEqual([{ id: 'c1', name: 'Site Manager' }]);
    expect(mergedSite.mdfIdfLocations).toEqual([{ id: 'm1', name: 'MDF-1' }]);
    expect(mergedSite.quickLinks.some((l) => l.icon === 'link' && l.name === 'Camera Vendor')).toBe(true);
    expect(mergedSite.quickLinks.filter((l) => l.icon === 'sheets')).toHaveLength(1);
    expect(mergedSite.quickLinks.find((l) => l.icon === 'sheets').name).not.toBe('Old Config Sheet');
  });

  it('keeps a zone polygon\'s repositioned geometry', () => {
    const existingCustomer = importSample();
    const floor = findLevel(existingCustomer, 'North', 'Level 1');
    const zone = floor.zones[0];
    zone.points = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];
    zone.color = '#ff0000';

    const imported = importSample(SAMPLE_ROWS, existingCustomer);
    const merged = mergeImportedCustomer(existingCustomer, imported);
    const mergedFloor = findLevel(merged, 'North', 'Level 1');

    expect(mergedFloor.zones[0].points).toEqual(zone.points);
    expect(mergedFloor.zones[0].color).toBe('#ff0000');
  });

  it('keeps a floor plan bgImage the sheet has no column for', () => {
    const existingCustomer = importSample();
    const floor = findLevel(existingCustomer, 'North', 'Level 1');
    floor.bgImage = 'floorplans/north-level-1.png';

    const imported = importSample(SAMPLE_ROWS, existingCustomer);
    const merged = mergeImportedCustomer(existingCustomer, imported);
    const mergedFloor = findLevel(merged, 'North', 'Level 1');

    expect(mergedFloor.bgImage).toBe('floorplans/north-level-1.png');
  });

  it('keeps a site the sheet no longer lists, and warns about it', () => {
    const existingCustomer = importSample();
    existingCustomer.sites.push({
      id: 'orphan-site', internalName: 'South', name: 'South Garage', levels: [],
    });

    const imported = importSample(SAMPLE_ROWS, existingCustomer);
    const merged = mergeImportedCustomer(existingCustomer, imported);

    expect(merged.sites.some((s) => s.id === 'orphan-site')).toBe(true);
    expect(merged.warnings).toEqual(expect.arrayContaining([expect.stringContaining('South')]));
  });
});
