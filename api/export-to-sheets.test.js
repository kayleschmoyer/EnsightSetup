/**
 * api/export-to-sheets.js reads the MySQL customer tree (loadCustomerFull)
 * and writes it back out to the 13-tab config spreadsheet. This is the other
 * half of the round-trip contract PR #2 established: src/lib/importedWorkbookMapping.js
 * + src/services/ExcelParserService.js read these same 13 tabs on import, so
 * what this endpoint writes for a customer built from the sample workbook
 * must reproduce that workbook's tabs. _db.js and Google are mocked; the
 * parser, the mapper and the export endpoint itself are real.
 */
/* global Buffer */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSampleWorkbookBuffer, SAMPLE_ROWS } from '../src/services/__fixtures__/sampleWorkbook.js';
import { parseExcelFile } from '../src/services/ExcelParserService.js';
import { buildCustomerFromWorkbook } from '../src/lib/importedWorkbookMapping.js';
import { CONFIG_SHEET_TABS, detectionTypeFromDeviceType } from '../src/lib/configSheetSchema.js';

const auth = vi.hoisted(() => ({
  requireEnsightSession: vi.fn(async () => ({ email: 'staff@ensight.com' })),
}));
vi.mock('./_auth.js', () => auth);

const customersData = vi.hoisted(() => ({
  loadCustomerFull: vi.fn(),
}));
vi.mock('./_customers-data.js', () => customersData);

const pool = vi.hoisted(() => ({ query: vi.fn(async () => [{ affectedRows: 1 }]) }));
vi.mock('./_db.js', () => ({ getPool: () => pool }));

const google = vi.hoisted(() => ({
  googleAccessToken: vi.fn(async () => 'sa-token'),
}));
vi.mock('./_google.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, googleAccessToken: google.googleAccessToken };
});

const { default: handler } = await import('./export-to-sheets.js');
const { SHEETS_API } = await import('./_google.js');

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

/** A minimal Node req whose 'data'/'end' listeners fire synchronously, same as api/_http.js's readBody expects. */
function fakeReq(body) {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    headers: { origin: 'http://localhost:5173', cookie: '' },
    on(event, cb) {
      if (event === 'data') cb(raw);
      else if (event === 'end') cb();
    },
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
}

/** Stub fetch for Google Sheets/Drive, recording every tab's written [headers, ...rows]. */
function stubGoogleFetch() {
  const writesByTab = {};
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u === SHEETS_API && init.method === 'POST') {
      return jsonResponse({ spreadsheetId: 'sheet-1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1' });
    }
    if (u.includes('/files/') && init.method === 'PATCH') {
      return jsonResponse({});
    }
    if (u.includes(':clear')) {
      return jsonResponse({});
    }
    if (init.method === 'PUT') {
      const tab = decodeURIComponent(u).match(/'([^']+)'!A1/)?.[1];
      const { values } = JSON.parse(init.body);
      writesByTab[tab] = values;
      return jsonResponse({});
    }
    return jsonResponse({});
  }));
  return writesByTab;
}

/** Build the sample-workbook customer through the real parse + import-mapping pipeline. */
function buildSampleCustomer() {
  const buffer = buildSampleWorkbookBuffer();
  const parsed = parseExcelFile(buffer);
  return buildCustomerFromWorkbook(parsed, { file: null, existingCustomer: null });
}

function devicesByPrefix(customer, prefix) {
  return customer.sites.flatMap((s) => s.levels.flatMap((l) => l.devices))
    .filter((d) => d.type.startsWith(prefix));
}

describe('POST /api/export-to-sheets', () => {
  let customer;
  let writesByTab;

  beforeEach(() => {
    vi.clearAllMocks();
    customer = buildSampleCustomer();
    customersData.loadCustomerFull.mockResolvedValue({ customer, updatedAt: '2026-09-03T00:00:00.000Z' });
    writesByTab = stubGoogleFetch();
  });

  it('reads the customer via loadCustomerFull, not Supabase, and writes every tab', async () => {
    const req = fakeReq({ customerId: 'cust-1' });
    const res = fakeRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(customersData.loadCustomerFull).toHaveBeenCalledWith('cust-1');
    expect(res.body.ok).toBe(true);
    expect(res.body.spreadsheetId).toBe('sheet-1');
    // Every one of the 13 tabs got written — this is exactly what regresses
    // to 0 rows (all but Customer) if buildAllTabRows reads customer.garages
    // instead of customer.sites.
    expect(res.body.changedTabs).toEqual(CONFIG_SHEET_TABS);
    for (const tab of CONFIG_SHEET_TABS) {
      expect(writesByTab[tab]?.length).toBeGreaterThan(1); // header + at least one row
    }
  });

  it('records spreadsheet_id/url/last_exported_at on the customer row via a MySQL UPDATE', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE customers SET/);
    expect(params[0]).toBe('sheet-1');
    expect(params[1]).toBe('https://docs.google.com/spreadsheets/d/sheet-1');
    expect(typeof params[2]).toBe('string'); // last_exported_at
    expect(params[3]).toBe('cust-1');
  });

  it('404s when the customer does not exist', async () => {
    customersData.loadCustomerFull.mockResolvedValue(null);
    const res = fakeRes();

    await handler(fakeReq({ customerId: 'missing' }), res);

    expect(res.statusCode).toBe(404);
  });

  it('Customer tab reproduces the sheet identity + card fields', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    const [, row] = writesByTab.Customer;
    expect(row).toEqual([
      'Acme Parking', 'acme', 'ACME', '1 Main St', 'Boston', 'MA', '02101',
      'https://maps.google.com/?q=1+Main+St', 'ensight', '', 'TRUE', 'FALSE',
    ]);
  });

  it('Garages tab reproduces the sheet garage row', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    expect(writesByTab.Garages.slice(1)).toEqual([['North', 'North Garage', 'Live']]);
  });

  it('DisplayGroups tab reproduces the sheet display group row', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    expect(writesByTab.DisplayGroups.slice(1)).toEqual([['Group1', 'FALSE', 15]]);
  });

  it('DisplaySchedules tab reproduces the sheet schedule row', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    expect(writesByTab.DisplaySchedules.slice(1)).toEqual(SAMPLE_ROWS.DisplaySchedules);
  });

  it('GarageLevels tab has one row per floor and zone imported from the sheet', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    const expectedLevelCount = customer.sites.flatMap((s) => s.levels).length;
    expect(expectedLevelCount).toBe(SAMPLE_ROWS.GarageLevels.length);
    expect(writesByTab.GarageLevels.slice(1)).toHaveLength(expectedLevelCount);
  });

  it('Networking tab has one row per imported server', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    const expectedServerCount = customer.sites[0].servers.length;
    expect(expectedServerCount).toBe(SAMPLE_ROWS.Networking.length);
    expect(writesByTab.Networking.slice(1)).toHaveLength(expectedServerCount);
  });

  it('SensorGroups tab has one row per imported sensor group', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    const expectedGroupCount = customer.sites.flatMap((s) => s.sensorGroups).length;
    expect(writesByTab.SensorGroups.slice(1)).toHaveLength(expectedGroupCount);
  });

  it('Cameras/FLICameras/LPRCameras tabs cover every imported camera device', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    const cameraDevices = devicesByPrefix(customer, 'cam-');
    expect(writesByTab.Cameras.slice(1)).toHaveLength(cameraDevices.length);
    const expectedFli = cameraDevices.filter((d) => detectionTypeFromDeviceType(d.type) === 'FLI').length;
    const expectedLpr = cameraDevices.filter((d) => detectionTypeFromDeviceType(d.type) === 'LPR').length;
    expect(writesByTab.FLICameras.slice(1)).toHaveLength(expectedFli);
    expect(writesByTab.LPRCameras.slice(1)).toHaveLength(expectedLpr);
  });

  it('DisplayControllers/DisplayLevels tabs cover every imported sign device', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    const signDevices = devicesByPrefix(customer, 'sign-');
    expect(writesByTab.DisplayControllers.slice(1)).toHaveLength(signDevices.length);
    expect(writesByTab.DisplayLevels.slice(1).length).toBeGreaterThan(0);
  });

  it('Sensors tab covers every imported sensor unit', async () => {
    await handler(fakeReq({ customerId: 'cust-1' }), fakeRes());

    const sensorDevices = devicesByPrefix(customer, 'sensor-');
    const expectedSensorRows = sensorDevices.reduce(
      (sum, d) => sum + (Array.isArray(d.sensors) && d.sensors.length ? d.sensors.length : 1),
      0,
    );
    expect(writesByTab.Sensors.slice(1)).toHaveLength(expectedSensorRows);
  });
});
