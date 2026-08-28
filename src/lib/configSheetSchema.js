/** Config Google Sheet tab order (left to right) — matches Ensight xlsx template. */
import { zoneSheetLevelName } from './zoneLevelUtils.js';

export const CONFIG_SHEET_TABS = Object.freeze([
  'Customer',
  'Networking',
  'Garages',
  'GarageLevels',
  'DisplayGroups',
  'DisplayControllers',
  'DisplayLevels',
  'DisplaySchedules',
  'Cameras',
  'FLICameras',
  'LPRCameras',
  'SensorGroups',
  'Sensors',
]);

/** Optional tab holding the full editor layout JSON (SetupJson). */
export const SETUP_JSON_TAB = 'SetupJson';

/**
 * Columns D/E carry the revision on the FIRST data row (row 2) so a client can
 * tell whether the snapshot changed by reading two cells instead of pulling the
 * whole payload back — which for a customer with twenty floor plans is ~10 MB
 * on every save.
 */
export const SETUP_JSON_HEADERS = Object.freeze([
  'ChunkIndex', 'ChunkTotal', 'Data', 'SavedAt', 'PayloadHash',
]);

/** A1 range holding SavedAt + PayloadHash (first data row, columns D:E). */
export const SETUP_JSON_REVISION_RANGE = "'SetupJson'!D2:E2";

/** Max characters per SetupJson chunk (Google Sheets cell limit ~50k).
 * Keep under Excel's 32,767 when possible for xlsx exports; 40k is used for Sheets.
 * Writes must use valueInputOption=RAW — USER_ENTERED treats leading +/= as formulas. */
export const SETUP_JSON_CHUNK_SIZE = 40000;

/**
 * Prefix for each SetupJson Data cell so the value can never be parsed as a formula
 * (base64 chunks often start with +). Stripped on read; legacy unprefixed cells still work.
 */
export const SETUP_JSON_CHUNK_DATA_PREFIX = 'SJ1:';

export const CONFIG_TAB_HEADERS = Object.freeze({
  Customer: [
    'FriendlyName', 'CustomerId', 'Code', 'Address', 'City', 'State', 'Zip',
    'GoogleMapsUrl', 'MaintenanceProvider', 'MaintenanceOther', 'EnterpriseSite', 'Support24Hour',
  ],
  Networking: [
    'Manufacturer', 'Device', 'Name', 'Status', 'Location', 'IDF/MDF Location',
    'IP Address  ', 'IP Assignment Method', 'MAC Address', 'Subnet', 'Gateway', 'DNS',
    'Username', 'Password', 'Notes', 'Stream Address',
  ],
  Garages: ['Garage', 'VisibleGarageName', 'Stage'],
  GarageLevels: [
    'Garage', 'Level', 'VisibleLevelName', 'Server', 'LevelType', 'VisibleOnPortal',
    'MaximumOccupancy', 'AutoResetCountsEnabled', 'AutoResetCountValue', 'AutoResetCountTime',
    'ForceFullVacancyThreshold', 'VehicleTransitThreshold', 'VehicleTransitThresholdTTLSeconds',
    'ShowFullMessage', 'ShowFullMessageRed', 'PortalDisplayOrdinal', 'SignDisplayOrdinal',
    'PortalRendering', 'VehicleRolesAllowed',
  ],
  DisplayGroups: ['Name', 'SendOnlyOnUpdates', 'ForceSendAfterSeconds'],
  DisplayControllers: [
    'DisplayName', 'DisplayControllerName', 'VisibleDisplayName', 'DisplayGroupName', 'Server',
    'IPAddress', 'Port', 'SerialAddress', 'DisplayProtocol', 'DisplayMap', 'HardwareType',
    'KeepLevelCountsSeparate',
  ],
  DisplayLevels: ['DisplayName', 'Garage', 'Level', 'PositionName', 'LevelName'],
  DisplaySchedules: [
    'DisplayName', 'StartTime', 'EndTime', 'Day', 'CountPositionX', 'CountPositionY',
    'CountWidth', 'CountHeight', 'FilePath', 'Garage1', 'Level1', 'Garage2', 'Level2',
  ],
  Cameras: [
    'Name', 'VisibleCameraName', 'IPAddress', 'Port', 'DetectionType', 'Server',
    'RTSPURL', 'Status', 'Resolution',
  ],
  FLICameras: [
    'CameraName', 'Garage', 'Level', 'BackOfCarIs', 'IsEntryExitCamera', 'DependentCameraName',
  ],
  LPRCameras: [
    'CameraName', 'Garage', 'Level', 'BackOfCarIs', 'IsEntryExitCamera', 'DependentCameraName',
  ],
  SensorGroups: [
    'GroupID', 'ControllerAddress', 'ControllerKey', 'SensorProtocol', 'Garage', 'Level', 'ParentLevel',
  ],
  Sensors: ['SensorName', 'SensorId', 'SensorGroupID', 'ParkingType', 'TempParkingTimeInMinutes'],
});

/** Build `{friendlyName}-config` spreadsheet title. */
export function configSheetTitle(friendlyName) {
  const base = String(friendlyName || 'Customer').trim().replace(/[^\w\s-]/g, '').trim() || 'Customer';
  return `${base}-config`;
}

export function detectionTypeFromDeviceType(type) {
  if (type === 'cam-lpr') return 'LPR';
  if (type === 'cam-people') return 'PEOPLE';
  return 'FLI';
}

export function typeTabForDetection(detectionType) {
  const upper = String(detectionType || '').toUpperCase();
  if (upper === 'LPR') return 'LPRCameras';
  if (upper === 'FLI') return 'FLICameras';
  return null;
}

export function backOfCarIsFromDirection(direction) {
  const d = String(direction || '').toLowerCase();
  if (d === 'in') return 'IN';
  if (d === 'out') return 'OUT';
  return '';
}

/** Format a value for writing to the config sheet (lowercase booleans like the xlsx template). */
export function formatSheetCellValue(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return String(val);
}

/** Uppercase TRUE/FALSE for GarageLevels boolean columns. */
export function formatSheetBoolUpper(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  const s = String(val).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return 'TRUE';
  if (s === 'false' || s === '0' || s === 'no') return 'FALSE';
  return String(val);
}

/** Default GarageLevels config values for new levels. */
export function defaultLevelSheetConfig(ordinal = 1) {
  return {
    server: '',
    levelType: 'FLI',
    visibleOnPortal: true,
    maximumOccupancy: 100,
    autoResetCountsEnabled: false,
    autoResetCountValue: 0,
    autoResetCountTime: '04:00',
    forceFullVacancyThreshold: 5,
    vehicleTransitThreshold: 0,
    vehicleTransitThresholdTTLSeconds: 0,
    showFullMessage: true,
    showFullMessageRed: true,
    portalDisplayOrdinal: ordinal,
    signDisplayOrdinal: ordinal,
    portalRendering: '',
    vehicleRolesAllowed: '',
  };
}

export function buildGarageSheetRow(site, stage = '') {
  const siteName = site.internalName || site.name || '';
  const visibleName = site.name || siteName;
  return [siteName, visibleName, stage || site.stage || ''];
}

export function buildGarageLevelSheetRow(site, level, ordinal) {
  const config = { ...defaultLevelSheetConfig(ordinal), ...(level.config || {}) };
  const siteName = site.internalName || site.name || '';
  const levels = site?.levels || [];
  // Zones: app name is short ("Zone 1"); sheet Level / VisibleLevelName are
  // "{Parent} {Name}" (e.g. "Level 1 Zone 1").
  const sheetLevelName = zoneSheetLevelName(level, levels)
    || level.internalName
    || level.name
    || '';
  const levelInternal = sheetLevelName;
  const visibleLevelName = sheetLevelName;
  // Zone-levels are normal GarageLevels rows — LevelType stays FLI (not "Zone").
  const rawType = String(config.levelType || 'FLI').trim() || 'FLI';
  const levelType = (level?.isZone === true || rawType.toLowerCase() === 'zone')
    ? 'FLI'
    : rawType;
  return [
    siteName,
    levelInternal,
    visibleLevelName,
    config.server || '',
    levelType,
    formatSheetBoolUpper(config.visibleOnPortal ?? true),
    level.totalSpots ?? config.maximumOccupancy ?? 100,
    formatSheetBoolUpper(config.autoResetCountsEnabled ?? false),
    config.autoResetCountValue ?? 0,
    config.autoResetCountTime || '04:00',
    config.forceFullVacancyThreshold ?? 5,
    config.vehicleTransitThreshold ?? 0,
    config.vehicleTransitThresholdTTLSeconds ?? 0,
    formatSheetBoolUpper(config.showFullMessage ?? true),
    formatSheetBoolUpper(config.showFullMessageRed ?? true),
    ordinal,
    ordinal,
    config.portalRendering || '',
    config.vehicleRolesAllowed || '',
  ];
}

/**
 * Build a Networking tab row from a LevelSelector-style server object.
 * Best-effort: many Networking columns have no site.servers equivalent.
 */
export function buildNetworkingSheetRow(server) {
  const port0 = Array.isArray(server?.ports) ? server.ports[0] : null;
  const ip = port0?.ip || server?.ipAddress || '';
  const mac = port0?.mac || server?.macAddress || '';
  const dhcp = port0?.dhcp ?? server?.dhcp;
  let ipAssignment = server?.ipAssignmentMethod || '';
  if (!ipAssignment && dhcp === true) ipAssignment = 'DHCP';
  if (!ipAssignment && dhcp === false) ipAssignment = 'Static';
  return [
    server?.manufacturer || '',
    server?.type || server?.device || '',
    server?.name || '',
    server?.status || '',
    server?.location || '',
    server?.mdfIdfLocation || '',
    ip,
    ipAssignment,
    mac,
    server?.subnet || '',
    server?.gateway || '',
    server?.dns || '',
    server?.splashtopUser || server?.username || '',
    server?.splashtopPassword || server?.password || '',
    server?.notes || '',
    server?.splashtopUrl || server?.streamAddress || '',
  ];
}

/**
 * Apply shared Networking/servers list onto every site.
 * Networking is customer-wide (no Garage column).
 */
export function applyServersToSites(sites = [], servers = []) {
  if (!Array.isArray(sites) || !sites.length) return sites;
  if (!Array.isArray(servers) || !servers.length) return sites;
  return sites.map((s) => ({
    ...s,
    servers: servers.map((sv) => ({ ...sv, ports: (sv.ports || []).map((p) => ({ ...p })) })),
  }));
}

/**
 * Prefer tab/Networking servers when present; otherwise keep SetupJson/local servers.
 */
export function mergeSitesPreferNetworkingServers(setupSites = [], tabSites = []) {
  const fromTabs = (tabSites || []).find((s) => Array.isArray(s?.servers) && s.servers.length)?.servers
    || [];
  if (fromTabs.length) {
    return applyServersToSites(setupSites, fromTabs);
  }
  return setupSites;
}

/**
 * Drop sensor groups that no device still references.
 */
export function pruneUnusedSensorGroups(site) {
  if (!site) return site;
  const used = new Set();
  for (const level of site.levels || []) {
    for (const device of level.devices || []) {
      if (device?.configSensorGroupId != null) used.add(device.configSensorGroupId);
    }
  }
  const nextGroups = (site.sensorGroups || []).filter((g) => used.has(g.id));
  if (nextGroups.length === (site.sensorGroups || []).length) return site;
  return { ...site, sensorGroups: nextGroups };
}

/**
 * Drop display groups that no sign still references.
 */
export function pruneUnusedDisplayGroups(site) {
  if (!site) return site;
  const used = new Set();
  for (const level of site.levels || []) {
    for (const device of level.devices || []) {
      if (device?.type?.startsWith('sign-') && device.displayGroupId != null) {
        used.add(device.displayGroupId);
      }
    }
  }
  const nextGroups = (site.displayGroups || []).filter((g) => used.has(g.id));
  if (nextGroups.length === (site.displayGroups || []).length) return site;
  return { ...site, displayGroups: nextGroups };
}

/** Default top-level customer card fields (address, maps, support). */
export function defaultCustomerConfig() {
  return {
    address: '',
    city: '',
    state: '',
    zip: '',
    mapsUrl: '',
    support: {
      maintenanceProvider: '',
      maintenanceOther: '',
      enterpriseSite: false,
      support24Hour: false,
    },
  };
}

export function buildCustomerSheetRow(customer, config) {
  const support = config?.support || {};
  return [
    customer?.friendlyName || '',
    customer?.customerId || '',
    customer?.code || '',
    config?.address || '',
    config?.city || '',
    config?.state || '',
    config?.zip || '',
    config?.mapsUrl || '',
    support.maintenanceProvider || '',
    support.maintenanceOther || '',
    formatSheetBoolUpper(support.enterpriseSite ?? false),
    formatSheetBoolUpper(support.support24Hour ?? false),
  ];
}

/** Default ForceSendAfterSeconds for new display groups. */
export const DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS = 15;

/** Default values for a new display update group. */
export function defaultDisplayGroup(id, name) {
  return {
    id,
    name: String(name || '').trim() || `Group${id}`,
    sendOnlyOnUpdates: false,
    forceSendAfterSeconds: DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS,
  };
}

/** Default values for a new MDF/IDF location entry. */
export function defaultMdfIdfLocation(id, name) {
  return {
    id,
    name: String(name || '').trim() || `MDF${id}`,
  };
}

/** Default values for a new sensor polling group. */
export function defaultSensorGroup(id, groupId) {
  return {
    id,
    groupId: String(groupId || '').trim() || `Group${id}`,
    controllerAddress: '',
    controllerKey: '',
    sensorProtocol: 'NWAVE',
    parentLevel: '',
  };
}

export function sensorProtocolFromDeviceType(type) {
  if (type === 'sensor-parksol') return 'Parksol';
  if (type === 'sensor-proco') return 'Proco';
  if (type === 'sensor-ensight') return 'Ensight';
  return 'NWAVE';
}

/**
 * Ensure a map sensor device has a site sensor group (configSensorGroupId).
 * Finds an existing group with the same protocol or creates one named after the protocol.
 * Also patches the device into site.levels so SensorGroups sheet rebuild sees it.
 *
 * @returns {{ device: object, site: object }}
 */
export function ensureDeviceSensorGroup(site, level, device) {
  if (!device?.type?.startsWith('sensor-')) {
    return { device, site };
  }

  let sensorGroups = [...(site?.sensorGroups || [])];
  let workingDevice = device;
  const hasGroup = workingDevice.configSensorGroupId != null
    && sensorGroups.some((g) => g.id === workingDevice.configSensorGroupId);

  if (!hasGroup) {
    const protocol = sensorProtocolFromDeviceType(workingDevice.type);
    const protocolKey = protocol.toUpperCase();
    let group = sensorGroups.find(
      (g) => String(g.sensorProtocol || '').toUpperCase() === protocolKey,
    );
    if (!group) {
      const newId = crypto.randomUUID();
      group = {
        ...defaultSensorGroup(newId, protocol),
        sensorProtocol: protocol,
      };
      sensorGroups = [...sensorGroups, group];
    }
    workingDevice = { ...workingDevice, configSensorGroupId: group.id };
  }

  const levelId = level?.id;
  const levels = (site?.levels || []).map((l) => {
    if (levelId != null && l.id !== levelId) return l;
    const devices = l.devices || [];
    const idx = devices.findIndex((d) => d.id === workingDevice.id);
    if (idx >= 0) {
      return {
        ...l,
        devices: devices.map((d) => (d.id === workingDevice.id ? { ...d, ...workingDevice } : d)),
      };
    }
    if (levelId != null && l.id === levelId) {
      return { ...l, devices: [...devices, workingDevice] };
    }
    return l;
  });

  return {
    device: workingDevice,
    site: { ...site, sensorGroups, levels },
  };
}

export function buildDisplayGroupSheetRow(group) {
  return [
    group.name || '',
    formatSheetBoolUpper(group.sendOnlyOnUpdates ?? false),
    group.forceSendAfterSeconds ?? DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS,
  ];
}

export function buildSensorGroupSheetRow(site, level, group) {
  const siteName = site?.internalName || site?.name || '';
  const levelName = level?.internalName || level?.name || '';
  return [
    group.groupId || '',
    group.controllerAddress || '',
    group.controllerKey || '',
    group.sensorProtocol || 'NWAVE',
    siteName,
    levelName,
    group.parentLevel || '',
  ];
}

/** Display protocol options for DisplayControllers sheet (DisplayProtocol column). */
export const DISPLAY_PROTOCOL_OPTIONS = Object.freeze([
  'ChainzoneDisplay',
  'Daktronics',
  'DaktronicsVMPL',
  'NovaController',
  'SerialDisplay',
  'SIGNALTECHSTATICDISPLAY',
  'SIGNALTECHSTATICFULLDISPLAY',
  'SIGNALTECHNORIGHTDISPLAY',
  'SIGNALTECHDUALDIRECTIONALDISPLAY',
  'SIGNALTECHDISPLAY',
  'SignalTechVMS',
  'WebpageDisplay',
]);

/** DisplayName / row key for DisplayControllers — prefer map ID (e.g. S1.1) over friendly name. */
export function signDisplayName(device) {
  const name = String(device?.name || '').trim();
  if (name) return name;
  return String(device?.friendlyName || '').trim();
}

export function displayGroupNameForDevice(device, displayGroups = []) {
  if (device?.displayGroupId != null) {
    const match = displayGroups.find((g) => g.id === device.displayGroupId);
    if (match?.name) return match.name;
  }
  return device?.displayGroupName || '';
}

export function sensorGroupIdForDevice(device, sensorGroups = []) {
  if (device?.configSensorGroupId != null) {
    const match = sensorGroups.find((g) => g.id === device.configSensorGroupId);
    if (match?.groupId) return match.groupId;
  }
  return '';
}

export function garageSheetName(site) {
  return site?.internalName || site?.name || '';
}

export function levelSheetInternalName(level, levels = null) {
  if (levels && level) {
    const composed = zoneSheetLevelName(level, levels);
    if (composed) return composed;
  }
  return level?.internalName || level?.name || '';
}

/** Build DisplayLevels tab rows for a sign (one row per level, or one row with Level = All). */
export function buildDisplayLevelSheetRows(device, sites = []) {
  const displayName = signDisplayName(device);
  if (!displayName || device?.displaySiteId == null) return [];

  const site = sites.find((s) => s.id === device.displaySiteId);
  if (!site) return [];

  const siteName = garageSheetName(site);
  const positionName = device?.positionName || '';

  if (device.displayLevelAll) {
    return [[displayName, siteName, 'All', positionName, '']];
  }

  const levelIds = Array.isArray(device.displayLevelIds) ? device.displayLevelIds : [];
  const levelEntries = levelIds.map((levelId) => {
    const level = (site.levels || []).find((l) => l.id === levelId);
    if (!level) return null;
    const sheetName = levelSheetInternalName(level, site.levels);
    return {
      internal: sheetName,
      name: sheetName,
    };
  }).filter(Boolean);

  if (levelEntries.length === 0) return [];

  if (levelEntries.length === 1) {
    const { internal, name } = levelEntries[0];
    return [[displayName, siteName, internal, positionName, name]];
  }

  const levelCell = levelEntries.map((e) => e.internal).join(',');
  return [[displayName, siteName, levelCell, positionName, '']];
}

export function buildDisplayControllerSheetRow(device, { displayGroups = [], servers = [] } = {}) {
  const displayName = signDisplayName(device);
  const serverName = (() => {
    if (device?.server) return String(device.server);
    if (device?.serverId != null) {
      const match = servers.find((s) => s.id === device.serverId);
      return match?.name || '';
    }
    return '';
  })();
  const displayProtocol = device?.displayProtocol || '';
  // Do not invent LED/STATIC/DESIGNABLE — those are not DisplayControllers protocol options.
  // Leave empty when unset so the sheet matches what the Inspector can select.
  return [
    displayName,
    device?.controllerName || displayName,
    device?.visibleName || displayName,
    displayGroupNameForDevice(device, displayGroups),
    serverName,
    device?.ipAddress || '',
    device?.port || '',
    device?.serialAddress || '',
    displayProtocol,
    device?.displayMap || '',
    device?.hardwareType || '',
    formatSheetBoolUpper(device?.keepLevelCountsSeparate ?? false),
  ];
}

export function buildSensorSheetRow(sensor, sensorGroupId) {
  return [
    sensor?.sensorName || sensor?.name || '',
    sensor?.sensorId || '',
    sensorGroupId || '',
    sensor?.parkingType || '',
    sensor?.tempParkingTimeInMinutes ?? '',
  ];
}

/** Build the default first site for a new customer. */
export function buildInitialCustomerSite(friendlyName, addressFields = {}) {
  const name = String(friendlyName || '').trim() || 'Site';
  const levelConfig = defaultLevelSheetConfig(1);
  return {
    id: crypto.randomUUID(),
    name,
    internalName: name,
    address: addressFields.address || '',
    city: addressFields.city || '',
    state: addressFields.state || '',
    zip: addressFields.zip || '',
    mapsUrl: addressFields.mapsUrl || '',
    image: '',
    quickLinks: [],
    contacts: [],
    servers: [],
    displayGroups: [],
    sensorGroups: [],
    mdfIdfLocations: [],
    levels: [{
      id: crypto.randomUUID(),
      name: 'Level 1',
      internalName: 'Level 1',
      totalSpots: 100,
      evSpots: 0,
      handicapSpots: 0,
      bgImage: null,
      devices: [],
      config: levelConfig,
    }],
  };
}
