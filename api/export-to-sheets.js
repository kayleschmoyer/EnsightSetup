/**
 * Vercel serverless function — one-way "Export to Sheets" for a customer.
 *
 * MySQL/RDS is the app's source of truth; this endpoint mirrors the current
 * state into the 13-tab xlsx-shaped spreadsheet that downstream on-prem
 * systems (EPIC, CameraHub, FLI) read, exactly like GoogleSheetsService.js's old
 * config-tab sync did — but triggered explicitly (a button), not on every save,
 * and as a full overwrite each tab rather than an upsert-preserving-hand-edits
 * merge, since there's no longer a second writer it needs to coordinate with.
 *
 * Secrets stay server-side: DB_* and GOOGLE_SERVICE_ACCOUNT_KEY are never
 * exposed as VITE_* vars. Follows the same CORS / body-size-limit /
 * secret-handling shape as create-clickup-task.js.
 *
 * Imports extensionless relative paths into src/lib (e.g. './configSheetSchema')
 * the same way the rest of the app does — this resolves under Vite and under
 * Vercel's Node builder (which bundles API routes with esbuild), but NOT via a
 * bare `node api/export-to-sheets.js`. Test it with `vercel dev`, not plain node.
 */
/* global Buffer, process */
import {
  CONFIG_SHEET_TABS,
  CONFIG_TAB_HEADERS,
  buildCustomerSheetRow,
  buildGarageSheetRow,
  buildGarageLevelSheetRow,
  buildNetworkingSheetRow,
  buildDisplayGroupSheetRow,
  buildSensorGroupSheetRow,
  buildDisplayControllerSheetRow,
  buildDisplayLevelSheetRows,
  buildSensorSheetRow,
  detectionTypeFromDeviceType,
  typeTabForDetection,
  backOfCarIsFromDirection,
  configSheetTitle,
  defaultCustomerConfig,
} from '../src/lib/configSheetSchema.js';
import { requireEnsightSession } from './_auth.js';
import { loadCustomerFull } from './_customers-data.js';
import { getPool } from './_db.js';
import {
  SHEETS_API, DRIVE_API, SHEETS_WRITE_SCOPES, googleAccessToken as serviceAccountToken, googleFetch, sharedFolderId,
} from './_google.js';

/**
 * Compliance gate: this endpoint's one write to the app's own production
 * database (recording which spreadsheet a customer's export landed in) is
 * enabled, same live-writes-on state as api/_customers-data.js. The Google
 * Sheets/Drive calls above this are a separate, already-approved live
 * integration. Flipping this back off requires a reviewed code change, not a
 * runtime/env toggle.
 */
const LIVE_DB_WRITE_ENABLED = true;

const MAX_BODY_BYTES = 256 * 1024;

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://localhost:5173',
];

function allowedOrigins() {
  const fromEnv = String(process.env.EXPORT_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ALLOWED_ORIGINS;
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    // Session is a cookie now, not a Bearer header — needed for the
    // VITE_SHEETS_EXPORT_URL-on-a-different-origin case (see .env.example).
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

/** Verify the caller's app session (see api/_auth.js) belongs to the org domain. */
async function requireCaller(req) {
  return requireEnsightSession(req);
}

/** Service-account token with Sheets + Drive write scope (see api/_google.js). */
function googleAccessToken() {
  return serviceAccountToken(SHEETS_WRITE_SCOPES);
}

/** Find or create the customer's config spreadsheet, tabs included. */
async function ensureSpreadsheet(token, customer) {
  if (customer.spreadsheetId) {
    return { spreadsheetId: customer.spreadsheetId, spreadsheetUrl: customer.spreadsheetUrl };
  }

  const folderId = sharedFolderId();

  // Locked in at customer-creation time (customers.config_sheet_name) — never
  // recomputed from the current friendly_name, so a later rename can't change
  // which spreadsheet this export targets.
  const title = customer.configSheetName || configSheetTitle(customer.friendlyName);
  const created = await googleFetch(SHEETS_API, token, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: CONFIG_SHEET_TABS.map((tabTitle) => ({
        properties: { title: tabTitle },
        data: [{ startRow: 0, startColumn: 0, rowData: [{
          values: (CONFIG_TAB_HEADERS[tabTitle] || []).map((h) => ({ userEnteredValue: { stringValue: h } })),
        }] }],
      })),
    }),
  });

  const spreadsheetId = created.spreadsheetId;
  // Move it into the shared customer-config Drive folder.
  await googleFetch(
    `${DRIVE_API}/files/${spreadsheetId}?addParents=${folderId}&fields=id,parents`,
    token,
    { method: 'PATCH', body: JSON.stringify({}) },
  );

  return { spreadsheetId, spreadsheetUrl: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
}

async function writeTab(token, spreadsheetId, tab, headers, rows) {
  const range = `'${tab}'!A1`;
  await googleFetch(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`'${tab}'!A1:ZZ100000`)}:clear`,
    token,
    { method: 'POST', body: JSON.stringify({}) },
  );
  await googleFetch(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    token,
    { method: 'PUT', body: JSON.stringify({ values: [headers, ...rows] }) },
  );
}

function buildCameraTabRows(garages) {
  const cameras = [];
  const fli = [];
  const lpr = [];
  for (const garage of garages) {
    const servers = garage.servers || [];
    for (const level of garage.levels || []) {
      for (const device of level.devices || []) {
        if (!device?.type?.startsWith('cam-')) continue;
        const detectionType = detectionTypeFromDeviceType(device.type);
        const serverName = device.server
          || servers.find((s) => s.id === device.serverId)?.name
          || '';
        cameras.push([
          device.name || '',
          device.visibleName || device.friendlyName || device.name || '',
          device.stream1?.ipAddress || '',
          device.stream1?.port || '',
          detectionType,
          serverName,
          device.stream1?.externalUrl || '',
          device.disabled ? 'Disabled' : 'Active',
          device.resolution || '',
        ]);
        const typeTab = typeTabForDetection(detectionType);
        if (typeTab) {
          const row = [
            device.name || '',
            garage.internalName || garage.name || '',
            level.internalName || level.name || '',
            backOfCarIsFromDirection(device.trafficFlow?.direction),
            device.isEntryExitCamera ? 'TRUE' : 'FALSE',
            device.dependentCameraName || '',
          ];
          (typeTab === 'FLICameras' ? fli : lpr).push(row);
        }
      }
    }
  }
  return { cameras, fli, lpr };
}

function buildSensorTabRows(garages) {
  const rows = [];
  for (const garage of garages) {
    for (const level of garage.levels || []) {
      for (const device of level.devices || []) {
        if (!device?.type?.startsWith('sensor-')) continue;
        const entries = Array.isArray(device.sensors) && device.sensors.length
          ? device.sensors
          : [{ sensorName: device.name, sensorId: device.sensorId || '' }];
        for (const sensor of entries) {
          if (sensor.sensorName || sensor.name) {
            rows.push(buildSensorSheetRow(sensor, device.configSensorGroupId ?? ''));
          }
        }
      }
    }
  }
  return rows;
}

function buildSignTabRows(garages) {
  const controllers = [];
  const displayLevels = [];
  for (const garage of garages) {
    for (const level of garage.levels || []) {
      for (const device of level.devices || []) {
        if (!device?.type?.startsWith('sign-')) continue;
        controllers.push(buildDisplayControllerSheetRow(device, {
          displayGroups: garage.displayGroups || [],
          servers: garage.servers || [],
        }));
        displayLevels.push(...buildDisplayLevelSheetRows(device, garages));
      }
    }
  }
  return { controllers, displayLevels };
}

/** Build every tab's rows from the legacy-shaped customer tree. */
function buildAllTabRows(customer) {
  const garages = customer.sites || [];
  const config = { ...defaultCustomerConfig(), ...(customer.config || {}) };

  const garageRows = garages.map((g) => buildGarageSheetRow(g));
  const garageLevelRows = garages.flatMap((g) => (g.levels || []).map((l, i) => buildGarageLevelSheetRow(g, l, i + 1)));
  const displayGroupRows = garages.flatMap((g) => (g.displayGroups || []).map((dg) => buildDisplayGroupSheetRow(dg)));
  const sensorGroupRows = garages.flatMap((g) => (g.sensorGroups || []).map((sg) => buildSensorGroupSheetRow(g, null, sg)));
  const networkingRows = (garages[0]?.servers || []).map((s) => buildNetworkingSheetRow(s));
  const displaySchedulesRows = (customer.displaySchedules || []).map((s) => [
    s.DisplayName || '', s.StartTime || '', s.EndTime || '', s.Day || '',
    s.CountPosition?.x ?? '', s.CountPosition?.y ?? '',
    s.CountPosition?.width ?? '', s.CountPosition?.height ?? '',
    s.FilePath || '', s.Garage1 || '', s.Level1 || '', s.Garage2 || '', s.Level2 || '',
  ]);

  const { cameras, fli, lpr } = buildCameraTabRows(garages);
  const { controllers, displayLevels } = buildSignTabRows(garages);
  const sensorRows = buildSensorTabRows(garages);

  return {
    Customer: [buildCustomerSheetRow(customer, config)],
    Networking: networkingRows,
    Garages: garageRows,
    GarageLevels: garageLevelRows,
    DisplayGroups: displayGroupRows,
    DisplayControllers: controllers,
    DisplayLevels: displayLevels,
    DisplaySchedules: displaySchedulesRows,
    Cameras: cameras,
    FLICameras: fli,
    LPRCameras: lpr,
    SensorGroups: sensorGroupRows,
    Sensors: sensorRows,
  };
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    json(res, 400, { error: err.message || 'Invalid request.' });
    return;
  }

  const customerId = String(body.customerId || '').trim();
  if (!customerId) {
    json(res, 400, { error: 'customerId is required.' });
    return;
  }

  try {
    await requireCaller(req);
  } catch (err) {
    json(res, 401, { error: err.message || 'Unauthorized.' });
    return;
  }

  try {
    const result = await loadCustomerFull(customerId);
    if (!result) {
      json(res, 404, { error: 'Customer not found.' });
      return;
    }

    const { customer } = result;
    const token = await googleAccessToken();
    const { spreadsheetId, spreadsheetUrl } = await ensureSpreadsheet(token, customer);

    const tabRows = buildAllTabRows(customer);
    const changedTabs = [];
    for (const tab of CONFIG_SHEET_TABS) {
      const rows = tabRows[tab] || [];
      if (!rows.length) continue;
      await writeTab(token, spreadsheetId, tab, CONFIG_TAB_HEADERS[tab], rows);
      changedTabs.push(tab);
    }

    const exportedAt = new Date().toISOString();
    if (LIVE_DB_WRITE_ENABLED) {
      const pool = getPool();
      await pool.query(
        'UPDATE customers SET spreadsheet_id = ?, spreadsheet_url = ?, last_exported_at = ? WHERE id = ?',
        [spreadsheetId, spreadsheetUrl, exportedAt, customerId],
      );
    }

    json(res, 200, { ok: true, spreadsheetId, spreadsheetUrl, changedTabs, exportedAt });
  } catch (err) {
    json(res, 502, { error: err.message || 'Failed to export to Sheets.' });
  }
}
