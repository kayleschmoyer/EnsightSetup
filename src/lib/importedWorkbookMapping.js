/**
 * importedWorkbookMapping — turn a parsed site-config workbook
 * (ExcelParserService.parseExcelFile) into the customer object the database
 * write path accepts (CustomerRepository.createCustomer / saveCustomerFull →
 * api/_customers-data.js), so every column on every tab has a home:
 *
 *   Customer          → customers / customer_addresses / customer_support
 *   Networking        → servers (cloned per site — the sheet is customer-wide)
 *   Garages           → sites (incl. stage)
 *   GarageLevels      → levels (floors) + zones (with a real parent floor)
 *   DisplayGroups     → display_groups (cloned per site)
 *   DisplayControllers/DisplayLevels → sign devices (+ inserts)
 *   DisplaySchedules  → display_schedules
 *   Cameras/FLI/LPR   → camera devices (+ stream 1, traffic flow)
 *   SensorGroups/Sensors → sensor_groups + sensor devices (+ units)
 *
 * Pure and dependency-free apart from sibling lib helpers, so it is unit
 * tested tab by tab without Drive, MySQL or a browser.
 */
import {
  fileNameStem,
  customerIdFromFileName,
  customerCodeFromFileName,
  customerIdFromFriendlyName,
  normalizeCustomerSupport,
} from './customerUtils';
import { defaultCustomerConfig } from './configSheetSchema';
import { ensureLinkedZonePolygon, isZoneLevel } from './zoneLevelUtils';

const str = (val) => (val == null ? '' : String(val).trim());
const bool = (val) => {
  if (typeof val === 'boolean') return val;
  const s = str(val).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
};
const num = (val) => {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};
const lower = (val) => str(val).toLowerCase();

/** Read a sheet cell by exact or trim/case-insensitive header match. */
function cell(row, ...names) {
  for (const key of names) {
    if (row?.[key] != null && String(row[key]).trim() !== '') return str(row[key]);
  }
  const wanted = new Set(names.map((n) => String(n).trim().toLowerCase()));
  for (const [key, value] of Object.entries(row || {})) {
    if (wanted.has(String(key).trim().toLowerCase()) && value != null && String(value).trim() !== '') {
      return str(value);
    }
  }
  return '';
}

function newId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Customer tab
// ---------------------------------------------------------------------------

/**
 * Identity + card config. The Customer tab wins; the Drive file name is the
 * fallback (it always was the key before the tab existed), and an already
 * imported customer keeps its friendly name unless the sheet names one.
 */
export function customerIdentityFromWorkbook(rawCustomer, { fileName = '', existingCustomer = null } = {}) {
  const row = rawCustomer || {};
  const sheetFriendly = cell(row, 'FriendlyName');
  const sheetCustomerId = cell(row, 'CustomerId');
  const sheetCode = cell(row, 'Code');

  const fileCode = customerCodeFromFileName(fileName);
  const customerId = (sheetCustomerId && customerIdFromFriendlyName(sheetCustomerId))
    || existingCustomer?.customerId
    || customerIdFromFileName(fileName);
  const friendlyName = sheetFriendly || existingCustomer?.friendlyName || fileNameStem(fileName) || fileCode;
  const code = sheetCode || existingCustomer?.code || fileCode;

  const support = normalizeCustomerSupport({
    maintenanceProvider: lower(cell(row, 'MaintenanceProvider')),
    maintenanceOther: cell(row, 'MaintenanceOther'),
    enterpriseSite: bool(cell(row, 'EnterpriseSite')),
    support24Hour: bool(cell(row, 'Support24Hour')),
  });
  const config = {
    ...defaultCustomerConfig(),
    address: cell(row, 'Address'),
    city: cell(row, 'City'),
    state: cell(row, 'State'),
    zip: cell(row, 'Zip', 'ZipCode'),
    mapsUrl: cell(row, 'GoogleMapsUrl', 'MapsUrl'),
    support,
  };
  return { customerId, code, friendlyName, config, hasCustomerTab: Boolean(rawCustomer) };
}

// ---------------------------------------------------------------------------
// DisplaySchedules tab
// ---------------------------------------------------------------------------

export function displaySchedulesFromRows(rows = []) {
  return (rows || [])
    .filter((row) => Object.values(row || {}).some((v) => str(v) !== ''))
    .map((row) => {
      const x = num(cell(row, 'CountPositionX'));
      const y = num(cell(row, 'CountPositionY'));
      const width = num(cell(row, 'CountWidth'));
      const height = num(cell(row, 'CountHeight'));
      const hasPosition = [x, y, width, height].some((v) => v != null);
      return {
        id: newId(),
        DisplayName: cell(row, 'DisplayName'),
        StartTime: cell(row, 'StartTime'),
        EndTime: cell(row, 'EndTime'),
        Day: cell(row, 'Day'),
        CountPosition: hasPosition ? { x, y, width, height } : null,
        FilePath: cell(row, 'FilePath'),
        Garage1: cell(row, 'Garage1'),
        Level1: cell(row, 'Level1'),
        Garage2: cell(row, 'Garage2'),
        Level2: cell(row, 'Level2'),
      };
    });
}

// ---------------------------------------------------------------------------
// GarageLevels → floors + zones
// ---------------------------------------------------------------------------

function levelNames(level) {
  return [level?.internalName, level?.name].map(str).filter(Boolean);
}

/**
 * A GarageLevels row is a zone-level when its Level reads "{floor} {zone}"
 * for another level in the same garage (the sheet convention, see
 * zoneSheetLevelName) or, on older sheets, when LevelType says Zone.
 * @returns {{ parent: object, shortName: string } | null}
 */
export function resolveZoneParent(level, levels) {
  const candidates = levelNames(level);
  let best = null;
  for (const other of levels || []) {
    if (other === level || other.id === level.id) continue;
    if (isZoneLevel(other)) continue;
    for (const parentName of levelNames(other)) {
      const prefix = `${parentName.toLowerCase()} `;
      for (const name of candidates) {
        if (name.toLowerCase().startsWith(prefix) && name.length > prefix.length) {
          const shortName = name.slice(prefix.length).trim();
          if (!best || parentName.length > best.parentName.length) {
            best = { parent: other, shortName, parentName };
          }
        }
      }
    }
  }
  if (!best) return null;
  return { parent: best.parent, shortName: best.shortName };
}

function linkedPolygonId(parentFloor, zoneLevelId) {
  const polygon = (parentFloor?.zones || []).find((z) => String(z?.linkedLevelId) === String(zoneLevelId));
  return polygon?.id ?? null;
}

/**
 * Attach every zone-level to its parent floor, draw the linked polygon on
 * that floor, and move the zone's devices onto the floor (the database only
 * stores devices on floors). Cameras that lived on a zone count into it via
 * trafficFlow.level (the floor) + trafficFlow.zone (the linked polygon).
 */
export function resolveZonesForSite(site, warnings = []) {
  let levels = (site.levels || []).map((l) => ({ ...l, devices: [...(l.devices || [])], zones: [...(l.zones || [])] }));

  // Pass 1: decide which levels are zones and who their parent is.
  const zoneInfo = new Map();
  for (const level of levels) {
    const byName = resolveZoneParent(level, levels);
    const flaggedZone = isZoneLevel(level);
    if (byName) {
      zoneInfo.set(level.id, byName);
    } else if (flaggedZone) {
      warnings.push(
        `${site.internalName || site.name}: level "${level.internalName || level.name}" is marked Zone but no parent level matches its name — imported as a floor.`,
      );
    }
  }

  // Pass 2: rewrite zone-levels and move their devices to the parent floor.
  levels = levels.map((level) => {
    const info = zoneInfo.get(level.id);
    if (!info) return { ...level, isZone: false, parentLevelId: null };
    return {
      ...level,
      isZone: true,
      parentLevelId: info.parent.id,
      name: info.shortName,
      internalName: info.shortName,
      config: {
        ...(level.config || {}),
        levelType: lower(level.config?.levelType) === 'zone' ? 'FLI' : (level.config?.levelType || 'FLI'),
      },
    };
  });

  for (const zone of levels.filter((l) => l.isZone)) {
    levels = ensureLinkedZonePolygon(levels, zone, zone.parentLevelId);
  }

  const byId = new Map(levels.map((l) => [l.id, l]));
  for (const zone of levels.filter((l) => l.isZone)) {
    const parent = byId.get(zone.parentLevelId);
    if (!parent) continue;
    const polygonId = linkedPolygonId(parent, zone.id);
    for (const device of zone.devices) {
      const moved = { ...device };
      if (String(device.type || '').startsWith('cam-')) {
        moved.trafficFlow = {
          ...(device.trafficFlow || {}),
          direction: device.trafficFlow?.direction || '',
          level: parent.id,
          zone: polygonId || '',
        };
      }
      parent.devices.push(moved);
    }
    zone.devices = [];
  }

  return { ...site, levels };
}

// ---------------------------------------------------------------------------
// Per-site fix-ups: servers / display groups cloned per site, names → ids
// ---------------------------------------------------------------------------

function cloneServersForSite(servers = []) {
  return (servers || []).map((server) => ({
    ...server,
    id: newId(),
    ports: (server.ports || []).map((p) => ({ ...p })),
  }));
}

function cloneDisplayGroupsForSite(groups = []) {
  const idMap = new Map();
  const cloned = (groups || []).map((group) => {
    const id = newId();
    idMap.set(String(group.id), id);
    return { ...group, id };
  });
  return { displayGroups: cloned, idMap };
}

function fixDevice(device, { serverIdByName, displayGroupIdMap, displayGroupIdByName, warnings, siteLabel }) {
  const next = { ...device };
  const serverName = lower(device.server);
  if (serverName) {
    const serverId = serverIdByName.get(serverName);
    if (serverId) next.serverId = serverId;
    else warnings.push(`${siteLabel}: device "${device.name}" references server "${device.server}" which is not on the Networking tab.`);
  }
  if (String(device.type || '').startsWith('sign-')) {
    const mapped = device.displayGroupId != null ? displayGroupIdMap.get(String(device.displayGroupId)) : null;
    next.displayGroupId = mapped
      || (device.displayGroupName ? displayGroupIdByName.get(lower(device.displayGroupName)) : null)
      || null;
    if (device.displayGroupName && !next.displayGroupId) {
      warnings.push(`${siteLabel}: sign "${device.name}" references display group "${device.displayGroupName}" which is not on the DisplayGroups tab.`);
    }
  }
  return next;
}

function driveQuickLink(file) {
  if (!file?.id) return null;
  const isNativeSheet = file.mimeType === 'application/vnd.google-apps.spreadsheet';
  const url = file.webViewLink
    || (isNativeSheet
      ? `https://docs.google.com/spreadsheets/d/${file.id}`
      : `https://drive.google.com/file/d/${file.id}/view`);
  return {
    id: 1,
    name: String(file.name || '').replace(/\.xlsx?$/i, '') || 'Configuration Sheet',
    url,
    icon: 'sheets',
  };
}

export function mapSiteForImport(site, { file = null, warnings = [] } = {}) {
  const siteLabel = site.internalName || site.name || 'Site';
  const servers = cloneServersForSite(site.servers);
  const serverIdByName = new Map(servers.filter((s) => s.name).map((s) => [lower(s.name), s.id]));
  const { displayGroups, idMap: displayGroupIdMap } = cloneDisplayGroupsForSite(site.displayGroups);
  const displayGroupIdByName = new Map(displayGroups.filter((g) => g.name).map((g) => [lower(g.name), g.id]));

  const resolved = resolveZonesForSite(site, warnings);
  const levels = resolved.levels.map((level) => ({
    ...level,
    devices: (level.devices || []).map((device) => fixDevice(device, {
      serverIdByName, displayGroupIdMap, displayGroupIdByName, warnings, siteLabel,
    })),
  }));

  const sheetLink = driveQuickLink(file);
  const quickLinks = [
    ...(sheetLink ? [sheetLink] : []),
    ...(site.quickLinks || []).filter((l) => l?.icon !== 'sheets'),
  ];

  return {
    ...site,
    stage: site.stage || '',
    servers,
    displayGroups,
    sensorGroups: (site.sensorGroups || []).map((g) => ({ ...g })),
    mdfIdfLocations: site.mdfIdfLocations || [],
    contacts: site.contacts || [],
    quickLinks,
    levels,
  };
}

// ---------------------------------------------------------------------------
// Whole workbook
// ---------------------------------------------------------------------------

export function summarizeImportedSites(sites = []) {
  let levels = 0;
  let zones = 0;
  let devices = 0;
  let servers = 0;
  for (const site of sites) {
    servers += (site.servers || []).length;
    for (const level of site.levels || []) {
      if (level.isZone) zones += 1; else levels += 1;
      devices += (level.devices || []).length;
    }
  }
  return { sites: sites.length, levels, zones, devices, servers };
}

/**
 * @param {{ sites: object[], rawData: object, sheetNames: string[], importStats?: object }} parsed
 * @param {{ file?: { id: string, name: string, mimeType?: string, webViewLink?: string },
 *   existingCustomer?: object|null }} [options]
 */
export function buildCustomerFromWorkbook(parsed, { file = null, existingCustomer = null } = {}) {
  if (!parsed || !Array.isArray(parsed.sites)) {
    throw new Error('Parsed workbook is missing its sites.');
  }
  const warnings = [];
  const fileName = file?.name || '';
  const identity = customerIdentityFromWorkbook(parsed.rawData?.customer, { fileName, existingCustomer });
  if (!identity.hasCustomerTab) {
    warnings.push('No Customer tab found — customer name and id were taken from the file name.');
  }

  const sites = parsed.sites.map((site) => mapSiteForImport(site, { file, warnings }));
  if (!sites.length) warnings.push('No rows on the Garages tab — the customer was imported without sites.');

  const skipped = parsed.importStats?.skippedDisplayLevelRows || 0;
  if (skipped) {
    warnings.push(`${skipped} DisplayLevels row(s) were skipped: no matching DisplayControllers row or level.`);
  }

  const displaySchedules = displaySchedulesFromRows(parsed.rawData?.displaySchedules);

  const spreadsheetUrl = file?.id
    ? (file.webViewLink || (file.mimeType === 'application/vnd.google-apps.spreadsheet'
      ? `https://docs.google.com/spreadsheets/d/${file.id}`
      : `https://drive.google.com/file/d/${file.id}/view`))
    : null;

  return {
    customerId: identity.customerId,
    code: identity.code,
    friendlyName: identity.friendlyName,
    config: identity.config,
    sites,
    displaySchedules,
    spreadsheetId: file?.id || null,
    spreadsheetUrl,
    sourceFileName: fileName,
    warnings,
    summary: summarizeImportedSites(sites),
  };
}
