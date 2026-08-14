/**
 * ExcelParserService - Parses the Ensight site configuration xlsx workbook
 * and maps it to the GarageLayout app data structure.
 *
 * Expected tabs:
 *   Networking, Garages, GarageLevels, DisplayGroups, DisplayControllers,
 *   DisplayLevels, DisplaySchedules, Cameras, FLICameras,
 *   LPRCameras, SensorGroups, Sensors
 */

import * as XLSX from 'xlsx';
import { DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS } from '../lib/configSheetSchema';
import { countGaragesDevices } from '../lib/deviceCountUtils';
import { nextSignName } from '../lib/deviceNamingUtils';
import { createSignInsert, groupDisplayControllersByMonument } from '../lib/signInserts';
import { normalizeTrafficDirection } from '../lib/trafficFlowUtils';

// ========================= SECURITY CONSTANTS =========================

/** Maximum rows allowed per sheet to prevent memory exhaustion */
const MAX_ROWS_PER_SHEET = 10000;

/** Maximum total devices across all levels */
const MAX_TOTAL_DEVICES = 50000;

// ========================= HELPERS =========================

/**
 * Sanitize a string to prevent XSS when rendered in the DOM.
 * Escapes HTML special characters.
 */
function sanitizeForDisplay(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Read a sheet into header row + data rows (preserves exact column order from row 1).
 */
function sheetHeadersAndRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return null;
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (rows.length > MAX_ROWS_PER_SHEET) {
    throw new Error(`Sheet "${sheetName}" exceeds maximum allowed rows (${MAX_ROWS_PER_SHEET}).`);
  }
  // Use exact keys from parsed rows so headers match object property names (incl. trailing spaces).
  const headers = rows.length > 0
    ? Object.keys(rows[0])
    : (matrix[0] || []).map((c) => String(c ?? ''));
  return { headers, rows };
}

/**
 * Read a sheet into an array of objects using the first row as headers.
 * Enforces row limits for security.
 */
function sheetToObjects(workbook, sheetName) {
  const parsed = sheetHeadersAndRows(workbook, sheetName);
  return parsed?.rows ?? [];
}

const str = (val) => (val == null ? '' : String(val).trim());
/** Sanitized string for values that will be displayed in UI */
const safeStr = (val) => sanitizeForDisplay(str(val));
/**
 * A cell a human formatted in Sheets reads back as display text — "1,000",
 * "$250", "75%". Number() returns NaN for all of those, which silently
 * replaced a real occupancy with the fallback. Strip the formatting first.
 */
const num = (val, fallback = 0) => {
  if (val == null || val === '') return fallback;
  if (typeof val === 'number') return Number.isFinite(val) ? val : fallback;
  const n = Number(val);
  if (Number.isFinite(n)) return n;

  const text = String(val).trim();
  const isPercent = text.endsWith('%');
  // Drop currency symbols, spaces and thousands separators; keep sign/decimal.
  const cleaned = text.replace(/%$/, '').replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || cleaned === '') return fallback;
  return isPercent ? parsed / 100 : parsed;
};
const bool = (val) => {
  if (typeof val === 'boolean') return val;
  const s = str(val).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
};

let nextId = 1;
function genId() {
  return nextId++;
}

/** True for DisplayLevels.Level values that mean every level (All, All Levels, etc.). */
export function isDisplayLevelAllToken(levelValue) {
  const normalized = str(levelValue).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized === 'all' || normalized === 'all levels' || normalized === 'all level';
}

/** Parse DisplayLevels.Level — supports "All" / "All Levels", a single level, or comma-separated levels. */
export function parseDisplayLevelField(levelValue) {
  const raw = str(levelValue);
  if (!raw) return { all: false, levelNames: [] };
  if (isDisplayLevelAllToken(raw)) return { all: true, levelNames: [] };
  return {
    all: false,
    levelNames: raw.split(',').map((part) => part.trim()).filter(Boolean),
  };
}

/** Read a Networking cell by exact or trim-insensitive header match. */
function networkingCell(row, ...candidates) {
  for (const key of candidates) {
    if (row?.[key] != null && String(row[key]).trim() !== '') return str(row[key]);
  }
  const wanted = new Set(candidates.map((c) => String(c).trim().toLowerCase()));
  for (const [key, value] of Object.entries(row || {})) {
    if (wanted.has(String(key).trim().toLowerCase()) && value != null && String(value).trim() !== '') {
      return str(value);
    }
  }
  return '';
}

function mapNetworkingDeviceToServerType(device) {
  const d = String(device || '').trim().toLowerCase();
  if (!d) return 'epic';
  if (d === 'epic' || d.includes('epic')) return 'epic';
  if (d === 'fli' || d.includes('fli')) return 'fli';
  if (d === 'camerahub' || d.includes('camera')) return 'camerahub';
  if (d === 'other' || d.includes('other')) return 'other';
  // Sheets often use Device = "Server" for generic hosts
  if (d === 'server' || d.includes('server')) return 'other';
  return d;
}

/**
 * Best-effort: map Networking tab rows to LevelSelector server objects.
 * Shared across garages (Networking has no Garage column).
 */
export function serversFromNetworkingRows(networkingRows = []) {
  const servers = [];
  networkingRows.forEach((row) => {
    const name = networkingCell(row, 'Name');
    if (!name) return;
    const ip = networkingCell(row, 'IP Address  ', 'IP Address', 'IPAddress');
    const mac = networkingCell(row, 'MAC Address', 'MACAddress');
    const assignment = networkingCell(row, 'IP Assignment Method').toLowerCase();
    const device = networkingCell(row, 'Device');
    const manufacturer = networkingCell(row, 'Manufacturer');
    servers.push({
      id: servers.length + 1,
      name,
      type: mapNetworkingDeviceToServerType(device),
      manufacturer,
      os: 'Windows Server 2022',
      ram: '',
      ssd: '',
      ports: [{
        mac,
        ip,
        dhcp: assignment.includes('dhcp'),
      }],
      ipAddress: ip,
      macAddress: mac,
      status: networkingCell(row, 'Status'),
      location: networkingCell(row, 'Location'),
      mdfIdfLocation: networkingCell(row, 'IDF/MDF Location'),
      subnet: networkingCell(row, 'Subnet'),
      gateway: networkingCell(row, 'Gateway'),
      dns: networkingCell(row, 'DNS'),
      splashtopUser: networkingCell(row, 'Username') || 'Administrator',
      splashtopPassword: networkingCell(row, 'Password'),
      splashtopUrl: networkingCell(row, 'Stream Address'),
      notes: networkingCell(row, 'Notes'),
    });
  });
  return servers;
}

function resolveLevelsForDisplayRow(levels, parsed) {
  if (parsed.all) return levels;
  if (!parsed.levelNames.length) return [];

  const byInternal = new Map(
    levels.map((level) => [str(level.internalName || level.name), level]),
  );
  const byVisible = new Map(levels.map((level) => [str(level.name), level]));
  const matched = [];
  const seen = new Set();

  for (const token of parsed.levelNames) {
    const level = byInternal.get(token) || byVisible.get(token);
    if (level && !seen.has(level.id)) {
      seen.add(level.id);
      matched.push(level);
    }
  }

  return matched;
}

function buildSignDeviceFromDisplayRow(dl, index, controller, garageId, displayLevelAll, displayLevelIds) {
  const displayName = str(dl.DisplayName);
  const displayProtocol = str(controller?.DisplayProtocol || dl.DisplayProtocol).toUpperCase();
  let signType = 'sign-static';
  if (displayProtocol === 'LED') signType = 'sign-led';
  else if (displayProtocol === 'DESIGNABLE') signType = 'sign-designable';

  return {
    id: genId(),
    name: displayName || `Display-${index + 1}`,
    friendlyName: displayName,
    signLogicalKey: String(displayName || `Display-${index + 1}`).trim().toLowerCase(),
    type: signType,
    ipAddress: str(controller?.IPAddress),
    port: str(controller?.Port),
    serialAddress: str(controller?.SerialAddress),
    displayProtocol: str(controller?.DisplayProtocol || dl.DisplayProtocol),
    displayMap: str(controller?.DisplayMap),
    displayGroupName: str(controller?.DisplayGroupName || dl.DisplayGroupName),
    visibleName: str(controller?.VisibleDisplayName || dl.LevelName),
    controllerName: str(controller?.DisplayControllerName || displayName),
    server: str(controller?.Server),
    hardwareType: str(controller?.InsertHardwareType),
    keepLevelCountsSeparate: bool(controller?.KeepLevelCountsSeparate),
    positionName: str(dl.PositionName),
    levelDisplayName: str(dl.LevelName),
    displayLevelAll: displayLevelAll,
    displayLevelIds: displayLevelIds,
    displayGarageId: garageId,
    pendingPlacement: true,
  };
}

function attachDisplaySignsForGarage({
  garageName,
  garageId,
  levels,
  displayLevelsData,
  displayControllersData,
  displayGroupIdByName,
  onDevicesAdded,
  onSkipped,
}) {
  const garageDisplayLevels = displayLevelsData.filter(
    (dl) => str(dl.Garage) === garageName && str(dl.DisplayName),
  );
  const displayLevelByName = new Map(
    garageDisplayLevels.map((dl) => [str(dl.DisplayName), dl]),
  );

  // Controllers that appear on this garage's DisplayLevels (plus any orphan controllers
  // only referenced here via DisplayName match).
  const relevantControllers = displayControllersData.filter((dc) => (
    displayLevelByName.has(str(dc.DisplayName))
  ));

  const monumentGroups = groupDisplayControllersByMonument(relevantControllers);
  let index = 0;

  for (const controllerRows of monumentGroups) {
    const isMonument = controllerRows.length >= 2;

    if (!isMonument) {
      const controller = controllerRows[0];
      const displayName = str(controller?.DisplayName);
      const dl = displayLevelByName.get(displayName);
      if (!dl) {
        onSkipped?.(displayName);
        continue;
      }
      const parsed = parseDisplayLevelField(dl.Level);
      const targetLevels = resolveLevelsForDisplayRow(levels, parsed);
      if (!targetLevels.length) {
        onSkipped?.(displayName);
        continue;
      }
      const levelIds = parsed.all ? [] : targetLevels.map((level) => level.id);
      targetLevels.forEach((level) => {
        const device = buildSignDeviceFromDisplayRow(
          dl,
          index,
          controller,
          garageId,
          parsed.all,
          parsed.all ? [] : levelIds,
        );
        if (device.displayGroupName) {
          device.displayGroupId = displayGroupIdByName.get(device.displayGroupName) ?? null;
        }
        level.devices.push(device);
        onDevicesAdded(1);
      });
      index += 1;
      continue;
    }

    // Multi-insert monument: one map device, N inserts (shared controller + IP).
    const inserts = [];
    let firstPlaceLevel = null;
    let controllerMeta = controllerRows[0];

    for (let i = 0; i < controllerRows.length; i += 1) {
      const controller = controllerRows[i];
      const displayName = str(controller.DisplayName);
      const dl = displayLevelByName.get(displayName);
      if (!dl) {
        onSkipped?.(displayName);
        continue;
      }
      const parsed = parseDisplayLevelField(dl.Level);
      const targetLevels = resolveLevelsForDisplayRow(levels, parsed);
      if (!targetLevels.length) {
        onSkipped?.(displayName);
        continue;
      }
      if (!firstPlaceLevel) firstPlaceLevel = targetLevels[0];
      controllerMeta = controller;

      inserts.push(createSignInsert({
        displayName,
        serialAddress: str(controller.SerialAddress),
        hasEthernet: i === 0,
        displayLevelAll: parsed.all,
        displayLevelIds: parsed.all ? [] : targetLevels.map((level) => level.id),
      }));
    }

    if (!inserts.length || !firstPlaceLevel) continue;

    const usedNames = new Set(
      (firstPlaceLevel.devices || []).map((d) => d.name).filter(Boolean),
    );
    // Prefer sheet DisplayNames on inserts; map ID uses S{level}.{n}.
    const levelNumMatch = String(firstPlaceLevel.internalName || firstPlaceLevel.name || '')
      .match(/(\d+)/);
    const namingLevel = levelNumMatch ? Number(levelNumMatch[1]) : (firstPlaceLevel.id || 1);
    const mapName = nextSignName(namingLevel, usedNames);
    const controllerName = str(controllerMeta.DisplayControllerName);

    const device = {
      id: genId(),
      name: mapName,
      friendlyName: controllerName || mapName,
      signLogicalKey: `${controllerName}|${str(controllerMeta.IPAddress)}|${mapName}`
        .trim()
        .toLowerCase(),
      type: (() => {
        const displayProtocol = str(controllerMeta.DisplayProtocol).toUpperCase();
        if (displayProtocol === 'LED') return 'sign-led';
        if (displayProtocol === 'DESIGNABLE') return 'sign-designable';
        return 'sign-static';
      })(),
      ipAddress: str(controllerMeta.IPAddress),
      port: str(controllerMeta.Port),
      serialAddress: inserts[0]?.serialAddress || '',
      displayProtocol: str(controllerMeta.DisplayProtocol),
      displayMap: str(controllerMeta.DisplayMap),
      displayGroupName: str(controllerMeta.DisplayGroupName),
      visibleName: str(controllerMeta.VisibleDisplayName),
      controllerName,
      server: str(controllerMeta.Server),
      hardwareType: str(controllerMeta.InsertHardwareType),
      keepLevelCountsSeparate: bool(controllerMeta.KeepLevelCountsSeparate),
      displayLevelAll: false,
      displayLevelIds: [firstPlaceLevel.id],
      displayGarageId: garageId,
      inserts,
      pendingPlacement: true,
    };
    if (device.displayGroupName) {
      device.displayGroupId = displayGroupIdByName.get(device.displayGroupName) ?? null;
    }
    firstPlaceLevel.devices.push(device);
    onDevicesAdded(1);
    index += 1;
  }
}

// ========================= MAIN PARSER =========================

/**
 * Parse an xlsx ArrayBuffer into the app's garage data structure.
 *
 * @param {ArrayBuffer} buffer - The xlsx file content
 * @returns {{ garages: Array, rawData: Object, sheetNames: string[] }}
 */
export function parseExcelFile(buffer) {
  // Security: Validate input buffer
  if (!buffer) {
    throw new Error('No file data provided.');
  }
  
  if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
    throw new Error('Invalid file data format.');
  }
  
  if (buffer.byteLength === 0) {
    throw new Error('File is empty.');
  }

  nextId = 1;
  const importStats = { skippedDisplayLevelRows: 0 };

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'array' });
  } catch (err) {
    throw new Error(`Failed to parse Excel file: ${err.message || 'Unknown error'}`);
  }
  
  const sheetNames = workbook.SheetNames;
  
  if (!sheetNames || sheetNames.length === 0) {
    throw new Error('Excel file contains no sheets.');
  }

  // Parse each tab (sheetToObjects enforces row limits)
  const networkingData = sheetToObjects(workbook, 'Networking');
  const garagesData = sheetToObjects(workbook, 'Garages');
  const garageLevelsData = sheetToObjects(workbook, 'GarageLevels');
  const displayGroupsData = sheetToObjects(workbook, 'DisplayGroups');
  const displayControllersData = sheetToObjects(workbook, 'DisplayControllers');
  const displayLevelsData = sheetToObjects(workbook, 'DisplayLevels');
  const displaySchedulesData = sheetToObjects(workbook, 'DisplaySchedules');
  const camerasData = sheetToObjects(workbook, 'Cameras');
  const fliCamerasData = sheetToObjects(workbook, 'FLICameras');
  const lprCamerasData = sheetToObjects(workbook, 'LPRCameras');
  const sensorGroupsData = sheetToObjects(workbook, 'SensorGroups');
  const sensorsData = sheetToObjects(workbook, 'Sensors');

  // Networking is customer-wide (no Garage column); attach to each garage like displayGroups.
  const importedServers = serversFromNetworkingRows(networkingData);

  const cameraByName = new Map();
  camerasData.forEach((row) => {
    const name = str(row.Name) || str(row.CameraName);
    if (name && !cameraByName.has(name)) {
      cameraByName.set(name, row);
    }
  });

  // Security: Track total devices to enforce limits
  let totalDeviceCount = 0;

  const displayGroups = displayGroupsData.map((dg, index) => ({
    id: index + 1,
    name: str(dg.Name),
    sendOnlyOnUpdates: bool(dg.SendOnlyOnUpdates),
    forceSendAfterSeconds: num(dg.ForceSendAfterSeconds, DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS),
  }));
  const displayGroupIdByName = new Map(
    displayGroups.map((g) => [g.name, g.id]).filter(([name]) => name),
  );
  
  // Build garage map
  const garages = garagesData.map((row) => {
    const garageName = str(row.Garage);
    const visibleName = safeStr(row.VisibleGarageName) || safeStr(row.Garage);
    const stage = str(row.Stage);

    const sensorGroups = [];
    const sensorGroupIdByKey = new Map();
    sensorGroupsData
      .filter((sg) => str(sg.Garage) === garageName)
      .forEach((sg) => {
        const groupKey = str(sg.GroupID);
        if (!groupKey || sensorGroupIdByKey.has(groupKey)) return;
        const id = sensorGroups.length + 1;
        sensorGroupIdByKey.set(groupKey, id);
        sensorGroups.push({
          id,
          groupId: groupKey,
          controllerAddress: str(sg.ControllerAddress),
          controllerKey: str(sg.ControllerKey),
          sensorProtocol: str(sg.SensorProtocol) || 'NWAVE',
          parentLevel: str(sg.ParentLevel),
        });
      });

    // Find levels for this garage
    const levelRows = garageLevelsData.filter(
      (l) => str(l.Garage) === garageName
    );

    const levels = levelRows.map((lr) => {
      const levelName = str(lr.Level);
      const visibleLevelName = safeStr(lr.VisibleLevelName) || safeStr(lr.Level);
      const server = str(lr.Server);
      const maxOccupancy = num(lr.MaximumOccupancy, 100);

      // Collect devices for this garage+level
      const devices = [];

      const cameraKeys = new Set();
      const makeCameraDevice = (cameraRow, fallbackType, sourceRow) => {
        const camName = str(sourceRow?.CameraName) || str(cameraRow?.Name) || str(cameraRow?.CameraName);
        if (!camName) return;

        const key = `${garageName}||${levelName}||${camName}`;
        if (cameraKeys.has(key)) return;
        cameraKeys.add(key);

        const detectionType = str(cameraRow?.DetectionType).toUpperCase();
        let deviceType = fallbackType || 'cam-fli';
        if (detectionType === 'LPR') deviceType = 'cam-lpr';
        else if (detectionType === 'PEOPLE' || detectionType === 'PEOPLECOUNTING') deviceType = 'cam-people';
        else if (detectionType === 'FLI') deviceType = 'cam-fli';

        // BackOfCarIs (IN/OUT) drives the Inspector "Back of car is" selection.
        const trafficDirection = normalizeTrafficDirection(
          str(sourceRow?.BackOfCarIs).toLowerCase()
        );

        devices.push({
          id: genId(),
          name: camName,
          type: deviceType,
          ipAddress: str(cameraRow?.IPAddress),
          port: str(cameraRow?.Port),
          rtspUrl: str(cameraRow?.RTSPURL),
          externalUrl: str(cameraRow?.RTSPURL),
          resolution: str(cameraRow?.Resolution),
          server: str(cameraRow?.Server) || server,
          status: str(cameraRow?.Status),
          visibleName: str(cameraRow?.VisibleCameraName),
          detectionType: str(cameraRow?.DetectionType),
          backOfCarIs: str(sourceRow?.BackOfCarIs),
          ...(trafficDirection ? { trafficFlow: { direction: trafficDirection } } : {}),
          isEntryExitCamera: bool(sourceRow?.IsEntryExitCamera),
          dependentCameraName: str(sourceRow?.DependentCameraName),
          pendingPlacement: true,
          macAddress: '',
          stream1: str(cameraRow?.RTSPURL),
          stream2: '',
          hardwareType: 'Bullet',
          configSheetName: camName,
        });
      };

      // --- Cameras on this level via FLICameras/LPRCameras mappings ---
      const fliForLevel = fliCamerasData.filter(
        (f) => str(f.Garage) === garageName && str(f.Level) === levelName
      );
      fliForLevel.forEach((fli) => {
        const camName = str(fli.CameraName);
        makeCameraDevice(cameraByName.get(camName), 'cam-fli', fli);
      });

      const lprForLevel = lprCamerasData.filter(
        (lpr) => str(lpr.Garage) === garageName && str(lpr.Level) === levelName
      );
      lprForLevel.forEach((lpr) => {
        const camName = str(lpr.CameraName);
        makeCameraDevice(cameraByName.get(camName), 'cam-lpr', lpr);
      });

      // --- Cameras assigned directly by garage+level in Cameras sheet ---
      camerasData
        .filter((cam) => str(cam.Garage) === garageName && str(cam.Level) === levelName)
        .forEach((cam) => {
          const detectionType = str(cam.DetectionType).toUpperCase();
          let fallbackType = 'cam-fli';
          if (detectionType === 'LPR') fallbackType = 'cam-lpr';
          else if (detectionType === 'PEOPLE' || detectionType === 'PEOPLECOUNTING') fallbackType = 'cam-people';
          makeCameraDevice(cam, fallbackType, null);
        });

      // --- Sensor Groups for this level ---
      const sensorGroupsForLevel = sensorGroupsData.filter(
        (sg) => str(sg.Garage) === garageName && str(sg.Level) === levelName
      );
      sensorGroupsForLevel.forEach((sg) => {
        const groupId = str(sg.GroupID);
        const protocol = str(sg.SensorProtocol);

        // Get individual sensors in this group
        const sensorsInGroup = sensorsData.filter(
          (s) => str(s.SensorGroupID) === groupId
        );

        // Map sensor protocol to device type
        const protocolLower = protocol.toLowerCase();
        let sensorType = 'sensor-nwave'; // default
        if (protocolLower === 'parksol' || protocolLower === 'parksolution') sensorType = 'sensor-parksol';
        else if (protocolLower === 'proco') sensorType = 'sensor-proco';
        else if (protocolLower === 'ensight') sensorType = 'sensor-ensight';
        else if (protocolLower === 'nwave') sensorType = 'sensor-nwave';

        devices.push({
          id: genId(),
          name: `SensorGroup-${groupId}`,
          type: sensorType,
          sensorProtocol: protocol,
          controllerAddress: str(sg.ControllerAddress),
          controllerKey: str(sg.ControllerKey),
          parentLevel: str(sg.ParentLevel),
          configSensorGroupId: sensorGroupIdByKey.get(groupId) ?? null,
          sensorCount: sensorsInGroup.length,
          sensors: sensorsInGroup.map((s) => ({
            sensorName: str(s.SensorName),
            sensorId: str(s.SensorId),
            parkingType: str(s.ParkingType),
            tempParkingTimeInMinutes: num(s.TempParkingTimeInMinutes),
          })),
          pendingPlacement: true,
        });
      });

      // Security: Track and enforce device limits
      totalDeviceCount += devices.length;
      if (totalDeviceCount > MAX_TOTAL_DEVICES) {
        throw new Error(`Too many devices in file. Maximum allowed is ${MAX_TOTAL_DEVICES}.`);
      }

      const levelType = str(lr.LevelType);
      const isZone = levelType.toLowerCase() === 'zone';

      return {
        id: genId(),
        name: visibleLevelName,
        internalName: levelName,
        totalSpots: maxOccupancy,
        evSpots: 0,
        handicapSpots: 0,
        bgImage: null,
        devices,
        zones: [],
        isZone,
        parentLevelId: null,
        // Store all the raw GarageLevel config
        config: {
          server,
          levelType,
          visibleOnPortal: bool(lr.VisibleOnPortal),
          maximumOccupancy: maxOccupancy,
          autoResetCountsEnabled: bool(lr.AutoResetCountsEnabled),
          autoResetCountValue: num(lr.AutoResetCountValue),
          autoResetCountTime: str(lr.AutoResetCountTime),
          forceFullVacancyThreshold: num(lr.ForceFullVacancyThreshold),
          vehicleTransitThreshold: num(lr.VehicleTransitThreshold),
          vehicleTransitThresholdTTLSeconds: num(lr.VehicleTransitThresholdTTLSeconds),
          showFullMessage: bool(lr.ShowFullMessage),
          showFullMessageRed: bool(lr.ShowFullMessageRed),
          portalDisplayOrdinal: num(lr.PortalDisplayOrdinal),
          signDisplayOrdinal: num(lr.SignDisplayOrdinal),
          portalRendering: str(lr.PortalRendering),
          vehicleRolesAllowed: str(lr.VehicleRolesAllowed),
        },
      };
    });

    const garageId = genId();

    attachDisplaySignsForGarage({
      garageName,
      garageId,
      levels,
      displayLevelsData,
      displayControllersData,
      displayGroupIdByName,
      onDevicesAdded: (count) => {
        totalDeviceCount += count;
        if (totalDeviceCount > MAX_TOTAL_DEVICES) {
          throw new Error(`Too many devices in file. Maximum allowed is ${MAX_TOTAL_DEVICES}.`);
        }
      },
      onSkipped: () => {
        importStats.skippedDisplayLevelRows += 1;
      },
    });

    return {
      id: garageId,
      name: visibleName,
      internalName: garageName,
      stage,
      address: str(row.Address),
      city: str(row.City),
      state: str(row.State),
      zip: str(row.Zip) || str(row.ZipCode),
      image: '',
      contacts: [],
      quickLinks: [],
      servers: importedServers.map((s) => ({ ...s })),
      displayGroups,
      sensorGroups,
      levels,
    };
  });

  // Store raw parsed data for reference and sheet export
  const sheets = {};
  for (const name of sheetNames) {
    const parsed = sheetHeadersAndRows(workbook, name);
    if (parsed) sheets[name] = parsed;
  }

  const rawData = {
    garages: garagesData,
    garageLevels: garageLevelsData,
    displayGroups: displayGroupsData,
    displayControllers: displayControllersData,
    displayLevels: displayLevelsData,
    displaySchedules: displaySchedulesData,
    cameras: camerasData,
    fliCameras: fliCamerasData,
    lprCameras: lprCamerasData,
    sensorGroups: sensorGroupsData,
    sensors: sensorsData,
    networking: sheets.Networking?.rows ?? [],
    sheets,
  };

  return { garages, rawData, sheetNames, importStats };
}

/**
 * Get a summary of what was parsed from the Excel file.
 *
 * @param {{ garages: Array, rawData: Object }} parsed
 * @returns {{ totalGarages: number, totalLevels: number, totalDevices: number, tabCounts: Object }}
 */
export function getImportSummary(parsed) {
  const { garages, rawData } = parsed;
  let totalLevels = 0;

  garages.forEach((g) => {
    totalLevels += g.levels.length;
  });

  const totalDevices = countGaragesDevices(garages);

  const tabCounts = {};
  for (const [key, arr] of Object.entries(rawData)) {
    tabCounts[key] = Array.isArray(arr) ? arr.length : 0;
  }

  return {
    totalGarages: garages.length,
    totalLevels,
    totalDevices,
    tabCounts,
    skippedDisplayLevelRows: parsed.importStats?.skippedDisplayLevelRows ?? 0,
  };
}
