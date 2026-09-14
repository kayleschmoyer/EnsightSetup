import React, { useState, useCallback, useMemo, useRef, useEffect, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useAppStore, useCurrentSite, useCurrentLevel, useLevels, useCustomerSites, useCurrentCustomer } from '../stores/useAppStore';

const MotionDiv = motion.div;
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from './ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import MapCanvas from './MapCanvas';
import InspectorPanel from './InspectorPanel';
// ConfigEditor pulls in Monaco (~3 MB). Lazy-load so it's only fetched when the
// Config tab is opened, drastically reducing initial bundle size and LCP delay.
const ConfigEditor = lazy(() => import('./ConfigEditor'));
import { exportAllConfigs } from '../services/ConfigService';
import {
  Home, Camera, MonitorSpeaker as SignIcon, Radio, Server, Plus, Trash2,
  FileDown, Settings, Eye, Filter, LayoutGrid, Code2,
  ChevronDown, ChevronUp, Search, X,
  ChevronsLeft, ChevronsRight, Image, MapPin, Square, Ban, SlidersHorizontal,
  MessageSquarePlus,
} from 'lucide-react';
import { DeviceIcon, DEVICE_ICON_MAP } from './DeviceIcons';
import AddCameraWizard from './AddCameraWizard';
import { virtualCountersForLevel } from '../lib/trafficFlowUtils';
import {
  CAMERA_PREFIX,
  nextCameraName,
  nextSignName,
  getLevelNamingNumber,
  isCameraType,
  compareCameraNames,
  cameraNameForTypeChange,
  withStreamType,
  applyDualLensNaming,
  expandDevicesForSidebar,
  isDualLensCamera,
} from '../lib/deviceNamingUtils';
import {
  defaultDisplayGroup,
  defaultSensorGroup,
  defaultMdfIdfLocation,
  displayGroupNameForDevice,
  ensureDeviceSensorGroup,
  pruneUnusedSensorGroups,
  pruneUnusedDisplayGroups,
  defaultLevelSheetConfig,
} from '../lib/configSheetSchema';
import { customerCanSyncToSheet } from '../lib/customerConfigUtils';
import { reconcileSignInSites, removeSignFromSite, signLogicalKey } from '../lib/deviceCountUtils';
import {
  ensureLinkedZonePolygon,
  floorLevels,
  isZoneLevel,
  nextZoneLevelName,
  removeLinkedZonePolygons,
} from '../lib/zoneLevelUtils';
import AppSettingsDialog from './AppSettingsDialog';
import ReportIssueDialog from './ReportIssueDialog';
import SetupSyncIndicator from './SetupSyncIndicator';
import { FLOOR_PLAN_ACCEPT, loadFloorPlanBackground } from '../lib/floorPlanBackground';
import { uploadFloorPlanBackground, deleteStorageObject, FLOOR_PLAN_BUCKET } from '../services/ImageUploadService';
import { formatFileSize } from '../lib/utils';
import { LOGICAL_W, LOGICAL_H } from '../lib/canvasConstants';
const deviceTypes = {
  cameras: [
    { id: 'cam-fli', name: 'FLI Camera' },
    { id: 'cam-lpr', name: 'LPR Camera' },
    { id: 'cam-people', name: 'People Counting' },
  ],
  hardwareTypes: [
    { id: 'dual-lens', name: 'Dual Lens', streams: 2 },
    { id: 'bullet', name: 'Bullet', streams: 1 },
  ],
  signs: [
    { id: 'sign-led', name: 'LED Sign' },
    { id: 'sign-static', name: 'Static Sign' },
    { id: 'sign-designable', name: 'Designable Sign' },
  ],
  sensorGroups: [
    { id: 'sensor-nwave', name: 'NWAVE' },
    { id: 'sensor-parksol', name: 'Parksol' },
    { id: 'sensor-proco', name: 'Proco' },
    { id: 'sensor-ensight', name: 'Ensight Vision' },
  ],
  parkingTypes: [
    { id: 'ev', name: 'EV' },
    { id: 'ada', name: 'ADA' },
    { id: 'normal', name: 'Normal' },
  ],
};

const safeArray = (arr) => Array.isArray(arr) ? arr : [];

/** New devices start unplaced — user clicks the map to set position. */
function defaultMapPlacement() {
  return {
    x: 0,
    y: 0,
    pendingPlacement: true,
  };
}

// Categories for the Quick-add picker in Level Settings.
const BULK_CATEGORIES = [
  {
    id: 'cameras',
    label: 'Cameras',
    icon: Camera,
    accent: 'text-blue-500',
    items: [
      { type: 'cam-fli',    label: 'FLI',    prefix: 'F', color: 'text-green-500' },
      { type: 'cam-lpr',    label: 'LPR',    prefix: 'L', color: 'text-blue-500' },
      { type: 'cam-people', label: 'People', prefix: 'P', color: 'text-cyan-500' },
    ],
  },
  {
    id: 'signs',
    label: 'Signs',
    icon: SignIcon,
    accent: 'text-amber-500',
    items: [
      { type: 'sign-led',        label: 'LED',        prefix: 'S', color: 'text-amber-500' },
      { type: 'sign-static',     label: 'Static',     prefix: 'S', color: 'text-yellow-500' },
      { type: 'sign-designable', label: 'Designable', prefix: 'S', color: 'text-orange-500' },
    ],
  },
  {
    id: 'sensors',
    label: 'Sensors',
    icon: Radio,
    accent: 'text-emerald-500',
    items: [
      { type: 'sensor-nwave',   label: 'NWAVE',   prefix: 'NW', color: 'text-emerald-500' },
      { type: 'sensor-parksol', label: 'Parksol', prefix: 'PK', color: 'text-teal-500' },
      { type: 'sensor-proco',   label: 'Proco',   prefix: 'PC', color: 'text-green-500' },
      { type: 'sensor-ensight', label: 'Ensight', prefix: 'EN', color: 'text-emerald-400' },
    ],
  },
];

function makeBulkDeviceShape(type) {
  if (type.startsWith('cam-')) {
    return {
      hardwareType: 'bullet',
      stream1: { ipAddress: '0.0.0.0', port: '554', externalUrl: '', streamType: type },
      ipAddress: '0.0.0.0', port: '554',
      trafficFlow: { direction: '', destinations: [] },
    };
  }
  if (type.startsWith('sign-')) {
    return {
      ipAddress: '',
      port: '',
      serialAddress: '',
      controllerName: '',
      visibleName: '',
      displayProtocol: '',
      displaySiteId: null,
      displayLevelAll: false,
      displayLevelIds: [],
      inserts: [],
    };
  }
  if (type.startsWith('sensor-')) {
    return {
      sensorGroup: type,
      sensorCount: 1,
      apiKey: type === 'sensor-nwave' ? '' : undefined,
    };
  }
  return {};
}

const SIGN_SHEET_SYNC_FIELDS = new Set([
  'displayGroupId',
  'serverId',
  'friendlyName',
  'controllerName',
  'visibleName',
  'ipAddress',
  'port',
  'serialAddress',
  'displayProtocol',
  'displaySiteId',
  'displayLevelAll',
  'displayLevelIds',
  'inserts',
]);

function makeEmptyBulkCounts() {
  const o = {};
  BULK_CATEGORIES.forEach(c => c.items.forEach(it => { o[it.type] = 0; }));
  return o;
}

// Device naming: device.name uses {levelId}.{seq}{prefix}
// Signs    -> S1.1, S1.2, S1.3 (leading S, no type suffix)
// Sensors  -> 1.1NW, 1.1PK, 1.1PC, 1.1EN
const DEVICE_PREFIX = {
  ...CAMERA_PREFIX,
  'sign-led': '',
  'sign-static': '',
  'sign-designable': '',
  'sensor-nwave': 'NW',
  'sensor-parksol': 'PK',
  'sensor-proco': 'PC',
  'sensor-ensight': 'EN',
};
function hasDevicePrefix(t) { return Object.prototype.hasOwnProperty.call(DEVICE_PREFIX, t); }
// Generic alias - same scheme works for any device type that has a prefix.
const nextDeviceName = nextCameraName;

const DEVICE_COLORS = {
  'cam-fli': '#22c55e',
  'cam-lpr': '#3b82f6',
  'cam-people': '#06b6d4',
  'sign-led': '#f59e0b',
  'sign-static': '#eab308',
  'sign-designable': '#f97316',
  'sensor-nwave': '#10b981',
  'sensor-parksol': '#14b8a6',
  'sensor-proco': '#22c55e',
  'sensor-ensight': '#34d399',
};

export default function EditorView() {
  const site = useCurrentSite();
  const currentLevel = useCurrentLevel();
  const levels = useLevels();
  const currentIsZoneLevel = isZoneLevel(currentLevel);
  const sites = useCustomerSites();
  const customer = useCurrentCustomer();
  const {
    selectedLevelId, setSelectedLevelId, setLevels, selectedDevice, setSelectedDevice,
    goHome, setSites,
  } = useAppStore();

  const [activeTab, setActiveTab] = useState('layout');
  const [filterType, setFilterType] = useState('all');
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [showReportIssue, setShowReportIssue] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [toast, setToast] = useState(null);
  const [searchDevice, setSearchDevice] = useState('');
  const [showCameraWizard, setShowCameraWizard] = useState(false);
  const [wizardCameraType, setWizardCameraType] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [hoveredDeviceId, setHoveredDeviceId] = useState(null);
  const [expandedDeviceGroups, setExpandedDeviceGroups] = useState({});
  const [bulkSelectedIds, setBulkSelectedIds] = useState(() => new Set());
  const [bgUploading, setBgUploading] = useState(false);
  const [placingDeviceId, setPlacingDeviceId] = useState(null);
  const [focusDeviceId, setFocusDeviceId] = useState(null);
  const [pdfPagePrompt, setPdfPagePrompt] = useState(null);
  const [narrowLayout, setNarrowLayout] = useState(false);
  const toastTimerRef = useRef(null);
  const stageRef = useRef(null);
  const setupSync = useAppStore((s) => s.setupSync);

  const canSyncToSheet = customerCanSyncToSheet(customer);

  const applyDeviceUpdate = useCallback((deviceId, nextDevice) => {
    const state = useAppStore.getState();
    const customer = state.customers.find((c) => c.id === state.selectedCustomerId);
    const site = customer?.sites?.find((s) => s.id === state.selectedSiteId);
    const level = site?.levels?.find((l) => l.id === state.selectedLevelId);
    if (!level || !site) return;

    const sw = stageRef.current?.width();
    const sh = stageRef.current?.height();
    const stageMeta = sw && sh ? { stageW: sw, stageH: sh } : {};

    if (nextDevice?.type?.startsWith('sign-')) {
      const newSites = reconcileSignInSites(sites, deviceId, nextDevice, {
        stageSiteId: site.id,
        stageLevelId: level.id,
        stageMeta,
      });
      setSites(newSites);
    } else {
      const newLevels = site.levels.map((l) =>
        l.id === level.id
          ? {
              ...l,
              devices: safeArray(l.devices).map((d) => (d.id === deviceId ? nextDevice : d)),
              ...stageMeta,
            }
          : l,
      );
      setLevels(newLevels);
    }
    if (state.selectedDevice?.id === deviceId) {
      const updatedSite = useAppStore.getState().customers
        .find((c) => c.id === state.selectedCustomerId)
        ?.sites?.find((s) => s.id === state.selectedSiteId);
      const updatedLevel = updatedSite?.levels?.find((l) => l.id === state.selectedLevelId);
      const refreshed = updatedLevel?.devices?.find((d) => d.id === deviceId)
        || updatedSite?.levels?.flatMap((l) => l.devices || []).find((d) => {
          if (!d.type?.startsWith('sign-')) return d.id === deviceId;
          const key = nextDevice.signLogicalKey || signLogicalKey(nextDevice);
          return (d.signLogicalKey || signLogicalKey(d)) === key;
        });
      setSelectedDevice(refreshed || nextDevice);
    }
  }, [setLevels, setSites, setSelectedDevice, stageRef, sites]);

  const devices = useMemo(() => safeArray(currentLevel?.devices), [currentLevel]);
  const virtualCounters = useMemo(
    () => virtualCountersForLevel(levels, currentLevel?.id),
    [levels, currentLevel?.id],
  );

  const filteredDevices = useMemo(() => {
    if (filterType === 'all') return devices;
    return devices.filter(d => {
      if (filterType === 'cameras') return d.type?.startsWith('cam-');
      if (filterType === 'signs') return d.type?.startsWith('sign-');
      if (filterType === 'sensors') return d.type?.startsWith('sensor-');
      return true;
    });
  }, [devices, filterType]);

  const sidebarDevices = useMemo(() => {
    let list = filteredDevices;
    if (searchDevice.trim()) {
      const q = searchDevice.toLowerCase();
      list = list.filter(d =>
        d.name?.toLowerCase().includes(q) ||
        d.friendlyName?.toLowerCase().includes(q) ||
        d.type?.toLowerCase().includes(q) ||
        d.stream1?.ipAddress?.includes(q) ||
        d.stream1?.configSheetName?.toLowerCase().includes(q) ||
        d.stream2?.configSheetName?.toLowerCase().includes(q) ||
        d.ipAddress?.includes(q)
      );
    }
    return [...list].sort((a, b) => compareCameraNames(a.name, b.name));
  }, [filteredDevices, searchDevice]);

  const sidebarRows = useMemo(
    () => expandDevicesForSidebar(sidebarDevices),
    [sidebarDevices],
  );

  // Only devices matching the sidebar type filter appear on the canvas.
  const placedDevices = useMemo(() => {
    return filteredDevices.filter((d) => !d.pendingPlacement);
  }, [filteredDevices]);

  const showToast = useCallback((msg, { duration = 3000 } = {}) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, duration);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1024px)');
    const apply = () => {
      const narrow = mq.matches;
      setNarrowLayout(narrow);
      if (narrow) {
        setSidebarCollapsed(true);
        setInspectorCollapsed(true);
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const addDisplayGroup = useCallback(async (name) => {
    if (!site) return null;
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const groups = site.displayGroups || [];
    const newId = crypto.randomUUID();
    const created = defaultDisplayGroup(newId, trimmed);
    const nextSite = { ...site, displayGroups: [...groups, created] };
    setSites(sites.map((s) => (s.id === site.id ? nextSite : s)));
    return created;
  }, [site, sites, setSites]);

  const addSensorGroup = useCallback(async (name) => {
    if (!site) return null;
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const groups = site.sensorGroups || [];
    const newId = crypto.randomUUID();
    const created = defaultSensorGroup(newId, trimmed);
    const nextSite = { ...site, sensorGroups: [...groups, created] };
    setSites(sites.map((s) => (s.id === site.id ? nextSite : s)));
    return created;
  }, [site, sites, setSites]);

  const addMdfIdfLocation = useCallback(async (name) => {
    if (!site) return null;
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const locations = site.mdfIdfLocations || [];
    const newId = crypto.randomUUID();
    const created = defaultMdfIdfLocation(newId, trimmed);
    const nextSite = { ...site, mdfIdfLocations: [...locations, created] };
    setSites(sites.map((s) => (s.id === site.id ? nextSite : s)));
    return created;
  }, [site, sites, setSites]);

  // Handler for AddCameraWizard
  const handleAddCameraFromWizard = useCallback(async (wizardDevice) => {
    if (!currentLevel) return;
    if (isZoneLevel(currentLevel)) {
      showToast('Zones cannot have cameras, signs, or sensors — place them on the parent floor.');
      return;
    }
    const existingDevices = safeArray(currentLevel.devices);
    const newId = crypto.randomUUID();

    let newDevice = {
      id: newId,
      rotation: 0,
      dhcp: false,
      friendlyName: '',
      ...defaultMapPlacement(),
      ...wizardDevice,
      name: wizardDevice.name || 'Camera',
    };

    if (isDualLensCamera(newDevice) && newDevice.stream2) {
      newDevice = applyDualLensNaming(
        newDevice,
        getLevelNamingNumber(currentLevel, levels),
        existingDevices,
        null,
        { preserveName: false },
      );
    } else {
      let name = (wizardDevice.name && wizardDevice.name !== 'Camera') ? wizardDevice.name : '';
      if (!name && isCameraType(wizardDevice.type)) {
        const used = new Set(existingDevices.map(d => d.name));
        name = nextCameraName(
          CAMERA_PREFIX[wizardDevice.type],
          getLevelNamingNumber(currentLevel, levels),
          used,
        );
      }
      newDevice.name = name || wizardDevice.name || 'Camera';
    }

    const newDevices = [...existingDevices, newDevice];
    setLevels(levels.map(l => l.id === currentLevel.id ? { ...l, devices: newDevices } : l));
    setSelectedDevice(newDevice);
    setInspectorCollapsed(false);
    setPlacingDeviceId(newDevice.id);
    showToast(`Added ${newDevice.name} — click the map to place`, { duration: 3500 });
  }, [currentLevel, levels, setLevels, setSelectedDevice, showToast]);

  // ============= Device CRUD =============

  const addDevice = useCallback(async (type, extraProps = {}) => {
    if (!currentLevel) return;
    if (isZoneLevel(currentLevel)) {
      showToast('Zones cannot have cameras, signs, or sensors — place them on the parent floor.');
      return;
    }
    const existingDevices = safeArray(currentLevel.devices);
    const newId = crypto.randomUUID();

    const typeInfo = [
      ...deviceTypes.cameras,
      ...deviceTypes.signs,
      ...deviceTypes.sensorGroups,
    ].find(t => t.id === type);

    const baseName = typeInfo?.name || 'Device';
    const count = existingDevices.filter(d => d.type === type).length;

    // All known device types (cameras, signs, sensors) get level-aware short IDs
    // (e.g. 1.1F, S1.1, 1.1NW). Unknown types fall back to descriptive name.
    // Use display ordinal / inferred level number — not internal level.id.
    const namingLevel = getLevelNamingNumber(currentLevel, levels);
    let resolvedName;
    if (hasDevicePrefix(type)) {
      const used = new Set(existingDevices.map(d => d.name));
      resolvedName = type.startsWith('sign-')
        ? nextSignName(namingLevel, used)
        : nextDeviceName(DEVICE_PREFIX[type], namingLevel, used);
    } else {
      resolvedName = `${baseName} ${count + 1}`;
    }

    const newDevice = {
      id: newId,
      type,
      name: resolvedName,
      friendlyName: '',
      rotation: 0,
      ...defaultMapPlacement(),
      // Camera properties
      hardwareType: type.startsWith('cam-') ? 'bullet' : undefined,
      stream1: type.startsWith('cam-') ? { ipAddress: '0.0.0.0', port: '554', externalUrl: '', streamType: type } : undefined,
      stream2: type.startsWith('cam-') && extraProps.hardwareType === 'dual-lens' ? { ipAddress: '0.0.0.0', port: '554', externalUrl: '', streamType: type } : undefined,
      // Sign properties
      ipAddress: type.startsWith('cam-') ? '0.0.0.0' : '',
      port: type.startsWith('cam-') ? '554' : '',
      serialAddress: type.startsWith('sign-') ? '' : undefined,
      controllerName: type.startsWith('sign-') ? '' : undefined,
      visibleName: type.startsWith('sign-') ? '' : undefined,
      displayProtocol: type.startsWith('sign-') ? '' : undefined,
      displaySiteId: type.startsWith('sign-') ? (site?.id ?? null) : undefined,
      displayLevelAll: type.startsWith('sign-') ? false : undefined,
      displayLevelIds: type.startsWith('sign-') && currentLevel ? [currentLevel.id] : undefined,
      // Monument / multi-insert: empty until user adds inserts (sheet falls back to map ID).
      inserts: type.startsWith('sign-') ? [] : undefined,
      // Sensor properties
      sensorGroup: type.startsWith('sensor-') ? type : undefined,
      sensorCount: type.startsWith('sensor-') ? 1 : undefined,
      apiKey: type === 'sensor-nwave' ? '' : undefined,
      // Traffic flow
      trafficFlow: type.startsWith('cam-') ? { direction: '', destinations: [] } : undefined,
      // Server assignment
      serverId: null,
      // DHCP
      dhcp: false,
      ...extraProps,
    };

    let deviceToAdd = newDevice;
    let nextLevels = levels.map((l) => (
      l.id === currentLevel.id ? { ...l, devices: [...existingDevices, deviceToAdd] } : l
    ));
    let nextSite = site
      ? { ...site, levels: nextLevels }
      : null;

    // Sensors must belong to a SensorGroups row before the Sensors tab can be written.
    if (type.startsWith('sensor-') && nextSite) {
      const ensured = ensureDeviceSensorGroup(
        nextSite,
        nextLevels.find((l) => l.id === currentLevel.id),
        deviceToAdd,
      );
      deviceToAdd = ensured.device;
      nextSite = ensured.site;
      nextLevels = nextSite.levels;
    }

    if (nextSite && type.startsWith('sensor-')) {
      setSites(sites.map((s) => (s.id === nextSite.id ? nextSite : s)));
    } else {
      setLevels(nextLevels);
    }
    setSelectedDevice(deviceToAdd);
    setInspectorCollapsed(false);

    setPlacingDeviceId(deviceToAdd.id);
    showToast(`Added ${resolvedName} — click the map to place`, { duration: 3500 });
  }, [currentLevel, levels, setLevels, setSites, setSelectedDevice, showToast, site, sites]);

  // Third arg (legacy { syncToSheet }) is still passed by InspectorPanel but
  // everything persists through the store auto-save now, so it's ignored.
  const updateDevice = useCallback(async (deviceId, updates) => {
    const state = useAppStore.getState();
    const customerState = state.customers.find((c) => c.id === state.selectedCustomerId);
    const siteState = customerState?.sites?.find((s) => s.id === state.selectedSiteId);
    const level = siteState?.levels?.find((l) => l.id === state.selectedLevelId);
    const existing = safeArray(level?.devices).find((d) => d.id === deviceId);
    if (!existing) return;

    let resolvedUpdates = { ...updates };
    const becomingDualLens = updates.hardwareType === 'dual-lens';
    const becomingBullet = updates.hardwareType === 'bullet';
    const deviceIsDualLens = isDualLensCamera(existing) || becomingDualLens;

    if (
      updates.type &&
      updates.type !== existing.type &&
      existing.type?.startsWith('cam-') &&
      updates.type.startsWith('cam-')
    ) {
      if (deviceIsDualLens) {
        // Dual-lens: top-level type follows Stream 1 only — never rewrite Stream 2.
        resolvedUpdates = {
          ...resolvedUpdates,
          stream1: withStreamType(existing.stream1, updates.type),
        };
      } else {
        const newName = cameraNameForTypeChange(
          existing,
          updates.type,
          getLevelNamingNumber(level, siteState?.levels || []),
          level.devices,
        );
        resolvedUpdates = {
          ...resolvedUpdates,
          name: newName,
          stream1: withStreamType(existing.stream1, updates.type),
        };
      }
    }

    const nextDevice = { ...existing, ...resolvedUpdates };
    // Switching this camera to bullet clears only its stream2 — never touch peers.
    if (becomingBullet && isDualLensCamera(existing)) {
      delete nextDevice.stream2;
    }
    if (
      isDualLensCamera(nextDevice)
      && nextDevice.stream2
      && typeof nextDevice.stream2 === 'object'
      && nextDevice.type?.startsWith('cam-')
    ) {
      // Re-name only when hardware / stream types change — not on IP/RTSP/port edits.
      const streamTypeChanged = (
        (resolvedUpdates.stream1
          && resolvedUpdates.stream1.streamType != null
          && resolvedUpdates.stream1.streamType !== (existing.stream1?.streamType || existing.type))
        || (resolvedUpdates.stream2
          && resolvedUpdates.stream2.streamType != null
          && resolvedUpdates.stream2.streamType !== existing.stream2?.streamType)
      );
      const namingTouched = becomingDualLens || streamTypeChanged;
      if (namingTouched) {
        Object.assign(
          nextDevice,
          applyDualLensNaming(
            nextDevice,
            getLevelNamingNumber(level, siteState?.levels || []),
            level.devices,
            deviceId,
            { preserveName: true },
          ),
        );
      }
    }
    if ('displayGroupId' in resolvedUpdates) {
      nextDevice.displayGroupName = displayGroupNameForDevice(
        nextDevice,
        siteState?.displayGroups || [],
      );
    }
    applyDeviceUpdate(deviceId, nextDevice);

    // Changing (or clearing) a sensor's group must leave it in a valid
    // protocol group — this assignment used to ride along the sheet-sync path.
    const isSensor = nextDevice.type?.startsWith('sensor-');
    if (isSensor && 'configSensorGroupId' in resolvedUpdates && siteState && level) {
      const hasValidGroup = nextDevice.configSensorGroupId != null
        && (siteState.sensorGroups || []).some((g) => g.id === nextDevice.configSensorGroupId);
      if (!hasValidGroup) {
        const stateAfter = useAppStore.getState();
        const customerAfter = stateAfter.customers.find((c) => c.id === stateAfter.selectedCustomerId);
        const siteAfter = customerAfter?.sites?.find((s) => s.id === stateAfter.selectedSiteId);
        const levelAfter = siteAfter?.levels?.find((l) => l.id === stateAfter.selectedLevelId);
        if (siteAfter && levelAfter) {
          const ensured = ensureDeviceSensorGroup(siteAfter, levelAfter, nextDevice);
          setSites((customerAfter?.sites || []).map((s) => (
            s.id === ensured.site.id ? ensured.site : s
          )));
          applyDeviceUpdate(deviceId, ensured.device);
        }
      }
    }

    if (resolvedUpdates.name && resolvedUpdates.name !== existing.name) {
      showToast(`Renamed to ${resolvedUpdates.name}`);
    }
  }, [applyDeviceUpdate, setSites, showToast]);

  const removeDevice = useCallback((deviceId) => {
    if (!currentLevel) return;
    // Unplace from map but keep the device data
    const newDevices = safeArray(currentLevel.devices).map(d =>
      d.id === deviceId ? { ...d, pendingPlacement: true, x: 0, y: 0 } : d
    );
    setLevels(levels.map(l => l.id === currentLevel.id ? { ...l, devices: newDevices } : l));
    if (selectedDevice?.id === deviceId) {
      setSelectedDevice({ ...selectedDevice, pendingPlacement: true, x: 0, y: 0 });
    }
    if (placingDeviceId === deviceId) setPlacingDeviceId(null);
    showToast('Device unplaced — use Place on map when ready');
  }, [currentLevel, levels, selectedDevice, placingDeviceId, setLevels, setSelectedDevice, showToast]);

  const deleteDevice = useCallback(async (deviceId) => {
    let deviceToDelete = null;
    for (const l of levels) {
      const match = safeArray(l.devices).find((d) => d.id === deviceId);
      if (match) {
        deviceToDelete = match;
        break;
      }
    }

    const newLevels = deviceToDelete?.type?.startsWith('sign-')
      ? removeSignFromSite({ levels }, deviceId)
      : levels.map((l) => ({
          ...l,
          devices: safeArray(l.devices).filter((d) => d.id !== deviceId),
        }));

    let nextSite = { ...site, levels: newLevels };
    if (deviceToDelete?.type?.startsWith('sensor-')) {
      nextSite = pruneUnusedSensorGroups(nextSite);
    }
    if (deviceToDelete?.type?.startsWith('sign-')) {
      nextSite = pruneUnusedDisplayGroups(nextSite);
    }

    setSites(sites.map((s) => (s.id === nextSite.id ? nextSite : s)));
    setLevels(newLevels);
    if (selectedDevice?.id === deviceId) setSelectedDevice(null);

    showToast('Device deleted');
  }, [levels, selectedDevice, setLevels, setSelectedDevice, setSites, showToast, site, sites]);

  const toggleBulkSelected = useCallback((deviceId, checked) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(deviceId);
      else next.delete(deviceId);
      return next;
    });
  }, []);

  useEffect(() => {
    setBulkSelectedIds(new Set());
  }, [selectedLevelId]);

  const deleteDevicesBulk = useCallback(async (deviceIds) => {
    const idSet = new Set(deviceIds);
    if (!idSet.size) return;

    const toDelete = [];
    const seen = new Set();
    for (const level of levels) {
      for (const device of safeArray(level.devices)) {
        if (!idSet.has(device.id) || seen.has(device.id)) continue;
        seen.add(device.id);
        toDelete.push(device);
      }
    }
    if (!toDelete.length) return;

    const sensors = toDelete.filter((d) => d.type?.startsWith('sensor-'));

    let newLevels = levels;
    for (const device of toDelete) {
      if (device.type?.startsWith('sign-')) {
        newLevels = removeSignFromSite({ levels: newLevels }, device.id);
      }
    }
    const nonSignIds = new Set(
      toDelete.filter((d) => !d.type?.startsWith('sign-')).map((d) => d.id),
    );
    if (nonSignIds.size) {
      newLevels = newLevels.map((level) => ({
        ...level,
        devices: safeArray(level.devices).filter((d) => !nonSignIds.has(d.id)),
      }));
    }

    let nextSite = { ...site, levels: newLevels };
    if (sensors.length) nextSite = pruneUnusedSensorGroups(nextSite);
    if (toDelete.some((d) => d.type?.startsWith('sign-'))) {
      nextSite = pruneUnusedDisplayGroups(nextSite);
    }

    setSites(sites.map((s) => (s.id === nextSite.id ? nextSite : s)));
    setLevels(newLevels);
    if (selectedDevice && idSet.has(selectedDevice.id)) setSelectedDevice(null);
    setBulkSelectedIds(new Set());

    const count = toDelete.length;
    showToast(`Deleted ${count} device${count === 1 ? '' : 's'}`);
  }, [
    levels, selectedDevice, setLevels, setSelectedDevice, setSites, showToast,
    site, sites,
  ]);

  const copyDevice = useCallback(async (deviceId) => {
    if (!currentLevel) return;
    const existingDevices = safeArray(currentLevel.devices);
    const source = existingDevices.find(d => d.id === deviceId);
    if (!source) return;
    const newId = crypto.randomUUID();
    const used = new Set(existingDevices.map((d) => d.name));
    const namingLevel = getLevelNamingNumber(currentLevel, levels);
    let copyName;
    if (source.type?.startsWith('sign-')) {
      copyName = nextSignName(namingLevel, used);
    } else if (hasDevicePrefix(source.type)) {
      copyName = nextDeviceName(DEVICE_PREFIX[source.type], namingLevel, used);
    } else {
      copyName = `${source.name} (Copy)`;
    }
    let copy = {
      ...JSON.parse(JSON.stringify(source)),
      id: newId,
      name: copyName,
      x: (source.x || 0) + 30,
      y: (source.y || 0) + 30,
      pendingPlacement: source.pendingPlacement ?? false,
    };
    if (copy.type?.startsWith('sign-')) {
      copy.signLogicalKey = String(copy.name).trim().toLowerCase();
    }
    if (isDualLensCamera(copy) && copy.stream2 && copy.type?.startsWith('cam-')) {
      copy = applyDualLensNaming(copy, namingLevel, existingDevices, null, { preserveName: false });
    }

    const newDevices = [...existingDevices, copy];
    setLevels(levels.map(l => l.id === currentLevel.id ? { ...l, devices: newDevices } : l));
    setSelectedDevice(copy);
    setInspectorCollapsed(false);

    if (copy.type?.startsWith('sensor-') && site) {
      const ensured = ensureDeviceSensorGroup(
        { ...site, levels: levels.map((l) => (l.id === currentLevel.id ? { ...l, devices: newDevices } : l)) },
        { ...currentLevel, devices: newDevices },
        copy,
      );
      copy = ensured.device;
      setSites(sites.map((s) => (s.id === ensured.site.id ? ensured.site : s)));
      setSelectedDevice(copy);
    }

    showToast(`Copied ${copy.name}`);
  }, [currentLevel, levels, setLevels, setSites, setSelectedDevice, showToast, site, sites]);

  // ============= Zones =============

  const [selectedZone, setSelectedZone] = useState(null);

  const zones = useMemo(() => safeArray(currentLevel?.zones), [currentLevel]);

  const addZone = useCallback(async () => {
    if (!currentLevel) return;
    if (isZoneLevel(currentLevel)) {
      showToast('Open the parent floor to add zones.');
      return;
    }

    const zoneName = nextZoneLevelName(currentLevel, levels);
    const newId = crypto.randomUUID();
    const ordinal = levels.length + 1;
    const newLevel = {
      id: newId,
      name: zoneName,
      internalName: zoneName,
      totalSpots: 100,
      evSpots: 0,
      handicapSpots: 0,
      bgImage: null,
      devices: [],
      zones: [],
      isZone: true,
      parentLevelId: currentLevel.id,
      config: {
        ...defaultLevelSheetConfig(ordinal),
        levelType: 'FLI',
      },
    };

    let nextLevels = [...levels, newLevel];
    nextLevels = ensureLinkedZonePolygon(nextLevels, newLevel, currentLevel.id, {
      logicalW: LOGICAL_W,
      logicalH: LOGICAL_H,
    });
    setLevels(nextLevels);

    const parentAfter = nextLevels.find((l) => l.id === currentLevel.id);
    const poly = safeArray(parentAfter?.zones).find(
      (z) => String(z.linkedLevelId) === String(newId),
    );
    if (poly) {
      setSelectedZone(poly);
      setSelectedDevice(null);
    }
    showToast(`Zone "${zoneName}" added`);
  }, [currentLevel, levels, setLevels, showToast, setSelectedDevice]);

  const updateZone = useCallback(async (zoneId, updates) => {
    if (!currentLevel) return;
    const existing = safeArray(currentLevel.zones).find((z) => z.id === zoneId);
    const newZones = safeArray(currentLevel.zones).map((z) => (
      z.id === zoneId ? { ...z, ...updates } : z
    ));
    let nextLevels = levels.map((l) => (
      l.id === currentLevel.id ? { ...l, zones: newZones } : l
    ));

    const linkedId = existing?.linkedLevelId ?? newZones.find((z) => z.id === zoneId)?.linkedLevelId;
    const nameChanged = updates && Object.prototype.hasOwnProperty.call(updates, 'name');
    if (linkedId != null && nameChanged) {
      const nextName = String(updates.name || '').trim();
      nextLevels = nextLevels.map((l) => (
        String(l.id) === String(linkedId)
          ? { ...l, name: nextName || l.name, internalName: nextName || l.internalName }
          : l
      ));
    }

    setLevels(nextLevels);
    setSelectedZone((prev) => (prev?.id === zoneId ? { ...prev, ...updates } : prev));
  }, [currentLevel, levels, setLevels]);

  const deleteZone = useCallback(async (zoneId) => {
    if (!currentLevel) return;
    const existing = safeArray(currentLevel.zones).find((z) => z.id === zoneId);
    let nextLevels = levels.map((l) => (
      l.id === currentLevel.id
        ? { ...l, zones: safeArray(l.zones).filter((z) => z.id !== zoneId) }
        : l
    ));

    if (existing?.linkedLevelId != null) {
      const linkedId = existing.linkedLevelId;
      nextLevels = nextLevels.filter((l) => String(l.id) !== String(linkedId));
      nextLevels = removeLinkedZonePolygons(nextLevels, linkedId);
    }

    setLevels(nextLevels);
    setSelectedZone(null);
    showToast('Zone deleted');
  }, [currentLevel, levels, setLevels, showToast]);

  const beginPlaceDevice = useCallback((deviceId) => {
    if (!currentLevel || deviceId == null) return;
    const device = safeArray(currentLevel.devices).find((d) => d.id === deviceId);
    if (!device) return;
    setSelectedDevice(device);
    setSelectedZone(null);
    setInspectorCollapsed(false);
    setPlacingDeviceId(deviceId);
    showToast('Click the map to place the device');
  }, [currentLevel, setSelectedDevice, showToast]);

  const finishPlaceAt = useCallback((deviceId, { x, y }) => {
    updateDevice(deviceId, { pendingPlacement: false, x, y });
    setPlacingDeviceId(null);
    setFocusDeviceId(deviceId);
    showToast('Device placed on map');
  }, [updateDevice, showToast]);

  // Layout keyboard shortcuts (skip when typing in inputs).
  useEffect(() => {
    const isTyping = (el) => {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };
    const onKeyDown = (e) => {
      if (isTyping(e.target)) return;
      if (e.key === 'Escape') {
        if (placingDeviceId != null) {
          setPlacingDeviceId(null);
          showToast('Place cancelled');
          return;
        }
        setSelectedDevice(null);
        setSelectedZone(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedZone) {
        e.preventDefault();
        deleteZone(selectedZone.id);
        return;
      }
      if (!selectedDevice || selectedDevice.pendingPlacement) return;
      const step = e.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      const nx = Math.min(LOGICAL_W, Math.max(0, (Number(selectedDevice.x) || 0) + dx));
      const ny = Math.min(LOGICAL_H, Math.max(0, (Number(selectedDevice.y) || 0) + dy));
      updateDevice(selectedDevice.id, { x: nx, y: ny });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [placingDeviceId, selectedDevice, selectedZone, deleteZone, updateDevice, showToast, setSelectedDevice]);

  // ============= PDF Export =============

  const exportPDF = useCallback(async () => {
    if (!site) return;
    try {
      // Dynamic import keeps jsPDF (~400 KB) out of the initial bundle.
      const { generateSitePDF } = await import('../services/PdfExportService');
      await generateSitePDF(site, currentLevel?.id, stageRef);
      showToast('PDF exported');
    } catch (e) {
      console.error('PDF export failed:', e);
      showToast('PDF export failed');
    }
  }, [site, currentLevel, showToast]);

  // ============= Config Export =============

  const handleExportConfigs = useCallback(() => {
    if (!devices.length) {
      showToast('No devices to export');
      return;
    }
    try {
      exportAllConfigs(devices, {
        sites: site ? [site] : [],
        projectName: customer?.name || site?.name,
      });
      showToast('Config files exported');
    } catch (err) {
      showToast('Export failed: ' + err.message);
    }
  }, [devices, showToast, site, customer]);

  // ============= Level Settings =============

  const [settingsForm, setSettingsForm] = useState({});
  const [bulkCounts, setBulkCounts] = useState(() => makeEmptyBulkCounts());
  const [expandedCategory, setExpandedCategory] = useState(null);

  const openSettings = useCallback(() => {
    if (!currentLevel) return;
    setSettingsForm({
      name: currentLevel.name,
      totalSpots: currentLevel.totalSpots,
      evSpots: currentLevel.evSpots,
      handicapSpots: currentLevel.handicapSpots,
    });
    setBulkCounts(makeEmptyBulkCounts());
    setExpandedCategory(null);
    setShowSettingsModal(true);
  }, [currentLevel]);

  const bulkSummary = useMemo(() => {
    const perCat = {};
    let total = 0;
    BULK_CATEGORIES.forEach(cat => {
      const sum = cat.items.reduce((s, it) => s + Math.max(0, parseInt(bulkCounts[it.type], 10) || 0), 0);
      perCat[cat.id] = sum;
      total += sum;
    });
    return { perCat, total };
  }, [bulkCounts]);

  const saveSettings = useCallback(async () => {
    if (!currentLevel || !settingsForm.name?.trim()) return;

    // Build any bulk devices requested (added as unplaced with default IDs).
    // Zone-levels never accept cameras / signs / sensors.
    const existingDevices = safeArray(currentLevel.devices);
    const usedNames = new Set(existingDevices.map(d => d.name));
    const newDevices = [];
    if (!isZoneLevel(currentLevel)) {
    BULK_CATEGORIES.forEach(cat => {
      cat.items.forEach(it => {
        const count = Math.max(0, parseInt(bulkCounts[it.type], 10) || 0);
        // Bulk-added devices share the level-aware name pattern:
        //   cameras/sensors {level}.{seq}{prefix} (1.1F, 1.1NW); signs S{level}.{seq}
        const namingLevel = getLevelNamingNumber(currentLevel, levels);
        const isSign = it.type.startsWith('sign-');
        const buildName = (seq) => (isSign
          ? `S${namingLevel}.${seq}`
          : `${namingLevel}.${seq}${it.prefix}`);
        let n = 1;
        for (let i = 0; i < count; i++) {
          let name = buildName(n);
          while (usedNames.has(name)) {
            n++;
            name = buildName(n);
          }
          usedNames.add(name);
          newDevices.push({
            id: crypto.randomUUID(),
            type: it.type,
            name,
            friendlyName: '',
            x: 0, y: 0, rotation: 0,
            pendingPlacement: true,
            serverId: null,
            dhcp: false,
            ...makeBulkDeviceShape(it.type),
            ...(it.type.startsWith('sign-') ? {
              displaySiteId: site?.id ?? null,
              displayLevelIds: [currentLevel.id],
            } : {}),
          });
          n++;
        }
      });
    });
    }

    let mergedDevices = newDevices.length ? [...existingDevices, ...newDevices] : existingDevices;
    const nextLevel = {
      ...currentLevel,
      name: settingsForm.name,
      totalSpots: Number(settingsForm.totalSpots) || 0,
      evSpots: Number(settingsForm.evSpots) || 0,
      handicapSpots: Number(settingsForm.handicapSpots) || 0,
      devices: mergedDevices,
    };

    const sensorBulk = newDevices.filter((d) => d.type?.startsWith('sensor-'));

    let siteForSave = site;
    if (sensorBulk.length && site) {
      let workingSite = {
        ...site,
        levels: levels.map((l) => (l.id === currentLevel.id ? { ...nextLevel, devices: mergedDevices } : l)),
      };
      for (const sensor of sensorBulk) {
        const ensured = ensureDeviceSensorGroup(
          workingSite,
          workingSite.levels.find((l) => l.id === currentLevel.id),
          mergedDevices.find((d) => d.id === sensor.id) || sensor,
        );
        workingSite = ensured.site;
        mergedDevices = workingSite.levels.find((l) => l.id === currentLevel.id)?.devices || mergedDevices;
      }
      nextLevel.devices = mergedDevices;
      siteForSave = workingSite;
    }

    const finalLevels = levels.map((l) => (
      l.id === currentLevel.id ? { ...nextLevel, devices: mergedDevices } : l
    ));
    if (sensorBulk.length && siteForSave) {
      setSites(sites.map((s) => (
        s.id === siteForSave.id ? { ...siteForSave, levels: finalLevels } : s
      )));
    } else {
      setLevels(finalLevels);
    }
    setShowSettingsModal(false);
    if (newDevices.length) {
      showToast(`Saved · added ${newDevices.length} device${newDevices.length === 1 ? '' : 's'}`);
    } else {
      showToast('Settings saved');
    }
    setBulkCounts(makeEmptyBulkCounts());
    setExpandedCategory(null);
  }, [currentLevel, settingsForm, bulkCounts, levels, setLevels, setSites, showToast, site, sites]);

  // ============= Background Image =============

  const applyFloorPlanResult = useCallback(async (result) => {
    if (!currentLevel || !result?.blob) return;
    const oldPath = currentLevel.bgImage;
    const path = await uploadFloorPlanBackground(customer?.id, site?.id, currentLevel.id, result.blob);
    setLevels(levels.map((l) => (l.id === currentLevel.id ? { ...l, bgImage: path } : l)));
    if (oldPath) deleteStorageObject(FLOOR_PLAN_BUCKET, oldPath).catch(() => {});
    if (result.sourceType === 'pdf') {
      showToast(
        result.pageCount > 1
          ? `Background set from PDF page ${result.pageNumber} of ${result.pageCount}`
          : 'Background set from PDF',
      );
    } else if (result.compressed) {
      // Full-size photos are downscaled so the upload stays fast and under budget —
      // say so rather than silently changing the file.
      showToast(
        `Background image updated · resized to ${formatFileSize(result.compressedBytes)} for sharing`,
        { duration: 5000 },
      );
    } else {
      showToast('Background image updated');
    }
  }, [currentLevel, levels, setLevels, showToast, customer, site]);

  const handleBgUpload = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !currentLevel) return;

    setBgUploading(true);
    try {
      const result = await loadFloorPlanBackground(file, { pageNumber: 1 });
      await applyFloorPlanResult(result);
      if (result.sourceType === 'pdf' && result.pageCount > 1) {
        setPdfPagePrompt({ file, pageCount: result.pageCount });
      }
    } catch (err) {
      showToast(err.message || 'Failed to load floor plan background.', { duration: 5000 });
    } finally {
      setBgUploading(false);
    }
  }, [currentLevel, applyFloorPlanResult, showToast]);

  const handlePdfPageConfirm = useCallback(async (pageNumber) => {
    if (!pdfPagePrompt?.file) return;
    setBgUploading(true);
    try {
      const result = await loadFloorPlanBackground(pdfPagePrompt.file, { pageNumber });
      await applyFloorPlanResult(result);
      setPdfPagePrompt(null);
    } catch (err) {
      showToast(err.message || 'Failed to load PDF page.', { duration: 5000 });
    } finally {
      setBgUploading(false);
    }
  }, [pdfPagePrompt, applyFloorPlanResult, showToast]);

  const clearBackground = useCallback(() => {
    if (!currentLevel?.bgImage) return;
    const oldPath = currentLevel.bgImage;
    setLevels(levels.map((l) => (l.id === currentLevel.id ? { ...l, bgImage: null } : l)));
    deleteStorageObject(FLOOR_PLAN_BUCKET, oldPath).catch(() => {});
    showToast('Background cleared');
  }, [currentLevel, levels, setLevels, showToast]);

  if (!site || !currentLevel) {
    return (
      <div className="h-screen flex items-center justify-center bg-background text-sm text-muted-foreground">
        Select a level to open the layout editor.
      </div>
    );
  }

  const cameras = devices.filter(d => d.type?.startsWith('cam-'));
  const signs = devices.filter(d => d.type?.startsWith('sign-'));
  const sensors = devices.filter(d => d.type?.startsWith('sensor-'));

  return (
    <div className="editor-page relative flex h-screen flex-col overflow-x-hidden overscroll-x-none bg-[#1d242c] text-white">
      {/* Header */}
      <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-[#495057] bg-[#151c23] px-4">
        <div className="flex items-center gap-2">
          <button
            onClick={goHome}
            className="cursor-pointer rounded-md p-1.5 text-[#949494] hover:bg-[#282e35] hover:text-white"
            title="Home — Customers"
            aria-label="Home — Customers"
          >
            <Home className="w-4 h-4" />
          </button>
          <Separator orientation="vertical" className="h-5 bg-[#3a424b]" />
          <span className="text-[15px] font-bold">Layout Editor</span>
          <span className="rounded border border-[#495057] bg-[#282e35] px-2.5 py-1 text-[10px] font-semibold text-[#adb5bd]">{site.name}</span>

          {/* Level Selector */}
          <Select value={String(selectedLevelId)} onValueChange={(v) => setSelectedLevelId(v)}>
            <SelectTrigger className="h-7 w-auto border-[#495057] bg-[#20272f] px-2 text-[11px] text-white shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {floorLevels(levels).map(l => (
                <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
              ))}
              {currentIsZoneLevel && currentLevel && (
                <SelectItem value={String(currentLevel.id)}>{currentLevel.name} (zone)</SelectItem>
              )}
            </SelectContent>
          </Select>

          <Separator orientation="vertical" className="h-5 bg-[#3a424b]" />

          {/* Stats */}
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="h-5 border-[#49b6d6]/50 bg-[#49b6d6]/10 text-[9px] text-[#49b6d6]">{cameras.length} cam</Badge>
            <Badge variant="outline" className="h-5 border-[#f59c1a]/50 bg-[#f59c1a]/10 text-[9px] text-[#f59c1a]">{signs.length} sign</Badge>
            <Badge variant="outline" className="h-5 border-[#00acac]/50 bg-[#00acac]/10 text-[9px] text-[#00acac]">{sensors.length} sensor</Badge>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <div className="mr-2">
            <SetupSyncIndicator />
          </div>

          {/* View Tabs */}
          <div
            className="mr-2 flex items-center rounded-[5px] border border-[#3a424b] bg-[#20272f] p-0.5"
            role="tablist"
            aria-label="Editor view"
          >
            {[
              { id: 'layout', icon: LayoutGrid, label: 'Layout' },
              { id: 'config', icon: Code2, label: 'Config' },
            ].map(({ id, icon: TabIcon, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={activeTab === id}
                onClick={() => setActiveTab(id)}
                className={`flex cursor-pointer items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-all ${
                  activeTab === id ? 'bg-[#282e35] text-white shadow-sm' : 'text-[#949494] hover:text-white'
                }`}
              >
                <TabIcon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          <Separator orientation="vertical" className="mx-1 h-5 bg-[#3a424b]" />

          {/* Actions */}
          <Button variant="ghost" size="icon-sm" className="text-[#949494] hover:bg-[#282e35] hover:text-white" onClick={exportPDF} title="Export PDF" aria-label="Export PDF">
            <FileDown className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-[#949494] hover:bg-[#282e35] hover:text-white" onClick={handleExportConfigs} title="Export Config" aria-label="Export config">
            <Code2 className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-[#949494] hover:bg-[#282e35] hover:text-white" onClick={() => setShowReportIssue(true)} title="Report issue or request" aria-label="Report issue or request">
            <MessageSquarePlus className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-[#949494] hover:bg-[#282e35] hover:text-white" onClick={() => setShowAppSettings(true)} title="App settings" aria-label="App settings">
            <Settings className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-[#949494] hover:bg-[#282e35] hover:text-white" onClick={openSettings} title="Level settings" aria-label="Level settings">
            <SlidersHorizontal className="w-4 h-4" />
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Tab Views */}
        {activeTab === 'layout' && (
          <>
            {/* Device Sidebar */}
            <aside className={`${sidebarCollapsed ? 'w-12' : 'w-64'} flex shrink-0 flex-col border-r border-[#3a424b] bg-[#151c23] transition-all duration-200`}>
              {sidebarCollapsed ? (
                <div className="flex flex-col items-center pt-2">
                  <button onClick={() => setSidebarCollapsed(false)} className="cursor-pointer rounded-md p-2 text-[#949494] hover:bg-[#282e35] hover:text-white">
                    <ChevronsRight className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between border-b border-[#3a424b] px-3 py-2.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#949494]">Devices</span>
                    <button onClick={() => setSidebarCollapsed(true)} className="cursor-pointer rounded p-1 text-[#949494] hover:bg-[#282e35] hover:text-white">
                      <ChevronsLeft className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Filter Tabs */}
                  <div className="border-b border-[#3a424b] px-2 py-2">
                    <div className="flex gap-1">
                      {[
                        { id: 'all', label: 'All' },
                        { id: 'cameras', label: 'Cam' },
                        { id: 'signs', label: 'Sign' },
                        { id: 'sensors', label: 'Sensor' },
                      ].map(f => (
                        <button
                          key={f.id}
                          onClick={() => setFilterType(f.id)}
                          className={`flex-1 cursor-pointer rounded-full border px-2 py-1 text-[10px] font-medium transition-all ${
                            filterType === f.id ? 'border-[#49b6d6]/60 bg-[#49b6d6]/15 text-[#49b6d6]' : 'border-[#3a424b] text-[#949494] hover:border-[#495057] hover:text-white'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Search in sidebar */}
                  <div className="border-b border-[#3a424b] px-2 py-2">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#6c757d]" />
                      <input
                        type="text"
                        placeholder="Search devices..."
                        value={searchDevice}
                        onChange={e => setSearchDevice(e.target.value)}
                        className="h-7 w-full rounded-[5px] border border-[#495057] bg-[#20272f] pl-7 pr-2 text-[11px] text-white placeholder:text-[#6c757d] focus:outline-none focus:ring-1 focus:ring-[#348fe2]"
                      />
                      {searchDevice && (
                        <button onClick={() => setSearchDevice('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 cursor-pointer">
                          <X className="w-3 h-3 text-[#949494]" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Existing device list */}
                  <ScrollArea className="flex-1">
                    <div className="p-1.5">
                      {/* Device count header + bulk actions */}
                      <div className="flex items-center justify-between gap-1 px-2 py-1 mb-1">
                        <span className="text-[10px] text-muted-foreground font-medium">
                          {sidebarDevices.length} device{sidebarDevices.length !== 1 ? 's' : ''}
                        </span>
                        {sidebarDevices.length > 0 && (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              className="text-[10px] text-[#348fe2] hover:underline cursor-pointer"
                              onClick={() => {
                                const allIds = sidebarDevices.map((d) => d.id);
                                const allSelected = allIds.every((id) => bulkSelectedIds.has(id));
                                setBulkSelectedIds(allSelected ? new Set() : new Set(allIds));
                              }}
                            >
                              {sidebarDevices.every((d) => bulkSelectedIds.has(d.id))
                                ? 'Clear'
                                : 'Select all'}
                            </button>
                            {bulkSelectedIds.size > 0 && (
                              <button
                                type="button"
                                className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold text-destructive hover:bg-destructive/15 cursor-pointer"
                                title="Permanently delete selected devices"
                                onClick={() => {
                                  const ids = [...bulkSelectedIds];
                                  const count = ids.length;
                                  setConfirmDelete({
                                    message: `Permanently delete ${count} selected device${count === 1 ? '' : 's'}? This also removes them from the Google Sheet.`,
                                    action: () => deleteDevicesBulk(ids),
                                  });
                                }}
                              >
                                <Trash2 className="w-3 h-3" />
                                Delete ({bulkSelectedIds.size})
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {sidebarDevices.length > 0 ? (
                        <div className="space-y-1">
                          {(() => {
                            const allTypeDefs = [
                              ...deviceTypes.cameras,
                              ...deviceTypes.signs,
                              ...deviceTypes.sensorGroups,
                            ];
                            const groups = allTypeDefs
                              .map(t => ({
                                id: t.id,
                                label: t.name,
                                rows: sidebarRows.filter(r => r.groupType === t.id),
                              }))
                              .filter(g => g.rows.length > 0);

                            // Catch-all bucket for any unknown types
                            const knownIds = new Set(allTypeDefs.map(t => t.id));
                            const unknown = sidebarRows.filter(r => !knownIds.has(r.groupType));
                            if (unknown.length > 0) {
                              groups.push({ id: '__other__', label: 'Other', rows: unknown });
                            }

                            return groups.map(group => {
                              const isExpanded = expandedDeviceGroups[group.id] ?? true;
                              const headerColor = DEVICE_COLORS[group.rows[0]?.groupType] || '#6b7280';
                              const groupKey = group.id || `group-${group.label || 'unknown'}`;
                              const groupDeviceIds = [...new Set(group.rows.map((r) => r.device.id))];
                              const groupAllSelected = groupDeviceIds.length > 0
                                && groupDeviceIds.every((id) => bulkSelectedIds.has(id));
                              return (
                                <div key={groupKey}>
                                  <div className="flex w-full items-center gap-1 rounded px-1.5 py-1">
                                    <input
                                      type="checkbox"
                                      className="h-3 w-3 shrink-0 accent-[#348fe2] cursor-pointer"
                                      checked={groupAllSelected}
                                      onChange={(e) => {
                                        const checked = e.target.checked;
                                        setBulkSelectedIds((prev) => {
                                          const next = new Set(prev);
                                          for (const id of groupDeviceIds) {
                                            if (checked) next.add(id);
                                            else next.delete(id);
                                          }
                                          return next;
                                        });
                                      }}
                                      aria-label={`Select all ${group.label}`}
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                    <button
                                      type="button"
                                      onClick={() => setExpandedDeviceGroups(prev => ({
                                        ...prev,
                                        [group.id]: !(prev[group.id] ?? true),
                                      }))}
                                      className="flex min-w-0 flex-1 items-center gap-1 text-left hover:opacity-90"
                                    >
                                      <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${!isExpanded ? '-rotate-90' : ''}`} />
                                      <DeviceIcon type={group.rows[0].groupType} className="w-3 h-3 shrink-0" style={{ color: headerColor }} />
                                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex-1 truncate">{group.label}</span>
                                      <span className="text-[10px] text-muted-foreground/70">{group.rows.length}</span>
                                    </button>
                                  </div>
                                  {isExpanded && (
                                    <div className="space-y-px mt-0.5 ml-3">
                                      {group.rows.map(({ device, sidebarName, streamKey }, rowIndex) => {
                                        const isSelected = selectedDevice?.id === device.id;
                                        const isBulkChecked = bulkSelectedIds.has(device.id);
                                        const color = DEVICE_COLORS[device.type] || '#6b7280';
                                        const isPending = device.pendingPlacement;
                                        const isDisabled = !!device.disabled;
                                        const fullLabel = device.friendlyName
                                          ? `${sidebarName} - ${device.friendlyName}`
                                          : sidebarName;
                                        const tooltipParts = [fullLabel];
                                        if (isPending && device.placementReason) tooltipParts.push(`Unplaced: ${device.placementReason}`);
                                        if (isDisabled && device.disabledReason) tooltipParts.push(`Disabled: ${device.disabledReason}`);
                                        else if (isDisabled) tooltipParts.push('Disabled');
                                        const rowKey = `dev-${device.id ?? 'x'}-${streamKey || 'main'}-${rowIndex}`;
                                        // Dual-lens expands to two rows — only show one checkbox per device.
                                        const showBulkCheckbox = group.rows.findIndex((r) => r.device.id === device.id) === rowIndex;

                                        return (
                                          <div
                                            key={rowKey}
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => {
                                              if (selectedDevice?.id === device.id) {
                                                if (inspectorCollapsed) {
                                                  setInspectorCollapsed(false);
                                                } else {
                                                  setSelectedDevice(null);
                                                }
                                              } else {
                                                setSelectedDevice(device);
                                                setInspectorCollapsed(false);
                                                if (!device.pendingPlacement) setFocusDeviceId(device.id);
                                              }
                                            }}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                e.currentTarget.click();
                                              }
                                            }}
                                            onMouseEnter={() => !isPending && setHoveredDeviceId(device.id)}
                                            onMouseLeave={() => setHoveredDeviceId(prev => prev === device.id ? null : prev)}
                                            title={tooltipParts.join('\n')}
                                             className={`flex w-full cursor-pointer items-center gap-1.5 rounded border px-2 py-1.5 text-left transition-colors ${
                                               isSelected
                                                 ? 'bg-[#348fe2]/15 border-[#348fe2]/40'
                                                 : isBulkChecked
                                                   ? 'bg-[#348fe2]/8 border-[#348fe2]/25'
                                                   : 'hover:bg-[#20272f] border-transparent'
                                            } ${isDisabled ? 'opacity-50' : ''}`}
                                          >
                                            {showBulkCheckbox ? (
                                              <input
                                                type="checkbox"
                                                className="h-3 w-3 shrink-0 accent-[#348fe2] cursor-pointer"
                                                checked={isBulkChecked}
                                                onChange={(e) => toggleBulkSelected(device.id, e.target.checked)}
                                                onClick={(e) => e.stopPropagation()}
                                                aria-label={`Select ${sidebarName}`}
                                              />
                                            ) : (
                                              <span className="w-3 shrink-0" aria-hidden />
                                            )}
                                            <DeviceIcon type={group.id !== '__other__' ? group.id : device.type} className="w-3.5 h-3.5 shrink-0" style={{ color: DEVICE_COLORS[group.id] || color }} />
                                            <span className={`text-[11px] font-medium flex-1 min-w-0 break-words ${isDisabled ? 'line-through' : ''}`}>
                                              {fullLabel}
                                            </span>
                                            {isDisabled && (
                                              <Ban className="w-3 h-3 shrink-0 text-destructive" />
                                            )}
                                            {isPending && (
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  beginPlaceDevice(device.id);
                                                }}
                                                className="shrink-0 p-0.5 rounded text-warning hover:bg-warning/15 cursor-pointer"
                                                title="Place on map"
                                                aria-label={`Place ${sidebarName} on map`}
                                              >
                                                <MapPin className="w-3 h-3" />
                                              </button>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      ) : (
                        <div className="text-center py-6 px-2">
                          <p className="text-[10px] text-muted-foreground">
                            {devices.length === 0
                              ? 'No devices yet — use Add above'
                              : 'No devices match this filter or search'}
                          </p>
                        </div>
                      )}

                      {/* Cameras on other levels counting traffic for this level */}
                      {virtualCounters.length > 0 && (
                        <div className="mt-3 pt-2 border-t border-border/60">
                          <div className="px-2 py-1 mb-1">
                            <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">
                              Virtual counters
                            </span>
                            <p className="text-[9px] text-muted-foreground/70 leading-snug mt-0.5">
                              Cameras on other levels counting traffic for this level
                            </p>
                          </div>
                          <div className="space-y-px">
                            {virtualCounters.map(({ device, sourceLevel, direction, role, targetLabel }) => (
                              <div
                                // A zone-pairing camera yields both a primary and an
                                // opposite entry for this level — key on both.
                                key={`virtual-${device.id}-${role}`}
                                className="px-2 py-1 rounded flex items-center gap-1.5"
                                title={`${device.name} is on ${sourceLevel.name} and counts ${direction.toUpperCase()} traffic for ${targetLabel || 'this level'}`}
                              >
                                <DeviceIcon
                                  type={device.type}
                                  className="w-3.5 h-3.5 shrink-0 opacity-60"
                                  style={{ color: DEVICE_COLORS[device.type] || '#6b7280' }}
                                />
                                <span className="text-[11px] flex-1 min-w-0 truncate text-muted-foreground">
                                  {device.name}
                                  <span className="text-muted-foreground/60"> · {sourceLevel.name}</span>
                                </span>
                                <span className={`shrink-0 text-[9px] font-semibold px-1 py-0.5 rounded border ${
                                  direction === 'in'
                                    ? 'text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                                    : 'text-orange-600 dark:text-orange-400 border-orange-500/30 bg-orange-500/10'
                                }`}>
                                  {direction.toUpperCase()}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </ScrollArea>

                  {/* BG Image */}
                  <div className="space-y-1 border-t border-[#3a424b] p-2">
                    <label className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-[#949494] transition-colors hover:bg-[#20272f] hover:text-white ${bgUploading ? 'opacity-60 pointer-events-none' : 'cursor-pointer'}`}>
                      <Image className="w-3.5 h-3.5" />
                      {bgUploading ? 'Loading background…' : (currentLevel.bgImage ? 'Change Background' : 'Set Background')}
                      <input type="file" accept={FLOOR_PLAN_ACCEPT} onChange={handleBgUpload} className="hidden" disabled={bgUploading} />
                    </label>
                    {currentLevel.bgImage && (
                      <button
                        type="button"
                        onClick={clearBackground}
                        className="w-full text-left px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                      >
                        Clear background
                      </button>
                    )}
                  </div>
                </>
              )}
            </aside>

            {/* Canvas + Add Device Bar */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Add New Device toolbar — not filtered by sidebar type chips */}
              <div className="flex items-center gap-1.5 overflow-x-auto border-b border-[#3a424b] bg-[#20272f] px-3 py-2">
                <span className="mr-2 shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#949494]">Add Device</span>
                {currentIsZoneLevel ? (
                  <span className="text-[11px] text-[#949494]">
                    Zone levels cannot have cameras, signs, or sensors. Open the parent floor to place devices and edit the zone polygon.
                  </span>
                ) : (
                  <>
                {[
                  ...deviceTypes.cameras.map(d => ({ ...d, category: 'cam' })),
                  ...deviceTypes.signs.map(d => ({ ...d, category: 'sign' })),
                  ...deviceTypes.sensorGroups.map(d => ({ ...d, category: 'sensor' })),
                ].map(d => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      if (d.category === 'cam') {
                        setWizardCameraType(d.id);
                        setShowCameraWizard(true);
                      } else {
                        addDevice(d.id);
                      }
                    }}
                    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-[#3a424b] bg-[#1d242c] px-2.5 py-1 transition-colors hover:border-[#495057] hover:bg-[#282e35]"
                    title={`Add ${d.name}`}
                    aria-label={`Add ${d.name}`}
                  >
                    <DeviceIcon type={d.id} className="w-3.5 h-3.5" style={{ color: DEVICE_COLORS[d.id] || '#6b7280' }} />
                    <span className="text-[10px] text-[#adb5bd]">{d.name}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={addZone}
                  className="ml-1 flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-[#49b6d6]/50 bg-[#1d242c] px-2.5 py-1 transition-colors hover:bg-[#282e35]"
                  title="Add Zone"
                  aria-label="Add zone"
                >
                  <Square className="w-3.5 h-3.5 text-sky-400" />
                  <span className="text-[10px] text-[#adb5bd]">Zone</span>
                </button>
                  </>
                )}
              </div>
              <div className="relative flex-1 overflow-hidden bg-[#0f141a]">
                {(setupSync?.status === 'saving' || setupSync?.status === 'conflict' || setupSync?.status === 'error') && (
                  <div className="absolute top-2 left-2 z-20 max-w-sm pointer-events-auto">
                    <div className={`text-[11px] rounded-md border px-2.5 py-1.5 shadow-sm bg-card/95 backdrop-blur-sm ${
                      setupSync.status === 'conflict' || setupSync.status === 'error'
                        ? 'border-amber-500/40 text-amber-800 dark:text-amber-200'
                        : 'border-border text-muted-foreground'
                    }`}>
                      {setupSync.status === 'saving' && 'Saving…'}
                      {setupSync.status === 'conflict' && 'Save conflict — use Reload or Overwrite in the header.'}
                      {setupSync.status === 'error' && (setupSync.error || 'Save failed — see header.')}
                    </div>
                  </div>
                )}
                <MapCanvas
                  devices={placedDevices}
                  zones={zones}
                  bgImage={currentLevel.bgImage}
                  selectedDevice={selectedDevice}
                  selectedZone={selectedZone}
                  onSelectDevice={(d) => {
                    setSelectedDevice(d);
                    if (d) {
                      setSelectedZone(null);
                      setInspectorCollapsed(false);
                      if (!d.pendingPlacement) setFocusDeviceId(d.id);
                    }
                  }}
                  onSelectZone={(z) => { setSelectedZone(z); if (z) setSelectedDevice(null); }}
                  onUpdateDevice={updateDevice}
                  onUpdateZone={updateZone}
                  deviceColors={DEVICE_COLORS}
                  stageRef={stageRef}
                  hoveredDeviceId={hoveredDeviceId}
                  placingDeviceId={placingDeviceId}
                  onPlaceAt={finishPlaceAt}
                  filterType={filterType}
                  focusDeviceId={focusDeviceId}
                  bgLoading={bgUploading}
                />
              </div>
            </div>

            {/* Device Inspector Panel */}
            {selectedDevice && !inspectorCollapsed && (
              <InspectorPanel
                device={selectedDevice}
                onUpdateDevice={updateDevice}
                onCopyDevice={copyDevice}
                onPlaceDevice={beginPlaceDevice}
                onRemoveDevice={(id) => {
                  const d = devices.find(d => d.id === id);
                  setConfirmDelete({ message: `Unplace \"${d?.name || 'device'}\" from the map? Device data is kept.`, action: () => removeDevice(id) });
                }}
                onDeleteDevice={(id) => {
                  const d = devices.find(d => d.id === id);
                  setConfirmDelete({ message: `Permanently delete \"${d?.name || 'device'}\"?`, action: () => deleteDevice(id) });
                }}
                servers={site.servers || []}
                displayGroups={site.displayGroups || []}
                sensorGroups={site.sensorGroups || []}
                mdfIdfLocations={site.mdfIdfLocations || []}
                sites={sites}
                onAddDisplayGroup={addDisplayGroup}
                onAddSensorGroup={addSensorGroup}
                onAddMdfIdfLocation={addMdfIdfLocation}
                levels={levels}
                currentLevel={currentLevel}
                deviceTypes={deviceTypes}
                canSyncToSheet={canSyncToSheet}
                customerId={customer?.id}
                siteId={site?.id}
                onClose={() => {
                  setInspectorCollapsed(true);
                  setSelectedDevice(null);
                }}
                onToast={showToast}
              />
            )}

            {narrowLayout && selectedDevice && inspectorCollapsed && (
              <button
                type="button"
                onClick={() => setInspectorCollapsed(false)}
                className="absolute bottom-20 right-3 z-30 px-3 py-1.5 rounded-md border border-border bg-card text-xs shadow-md"
              >
                Selected: {selectedDevice.name}
              </button>
            )}

            {/* Zone Inspector Panel */}
            {selectedZone && !selectedDevice && (
              <MotionDiv
                initial={{ x: 20, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                className="w-80 border-l border-[#3a424b] bg-[#151c23] text-white flex flex-col shrink-0 overflow-hidden shadow-[-12px_0_30px_rgba(0,0,0,0.12)]"
              >
                <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#3a424b] bg-[#192129]">
                  <div className="flex items-center gap-2">
                    <Square className="w-4 h-4" style={{ color: selectedZone.color || '#3b82f6' }} />
                    <span className="text-sm font-semibold">Zone</span>
                  </div>
                  <button onClick={() => setSelectedZone(null)} className="p-1 rounded hover:bg-white/10 cursor-pointer">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-4">
                  {/* Name */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Name</label>
                    <input
                      type="text"
                      value={selectedZone.name || ''}
                      onChange={e => updateZone(selectedZone.id, { name: e.target.value })}
                      className="w-full h-8 px-2.5 rounded-md bg-[#202932] border border-[#495057] text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>

                  {/* Color */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Color</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={selectedZone.color || '#3b82f6'}
                        onChange={e => updateZone(selectedZone.id, { color: e.target.value })}
                        className="w-8 h-8 rounded cursor-pointer border border-border bg-transparent"
                      />
                      <span className="text-xs font-mono text-muted-foreground">{selectedZone.color || '#3b82f6'}</span>
                    </div>
                  </div>

                  {/* Opacity */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-muted-foreground">Opacity</label>
                      <span className="text-xs text-muted-foreground">{Math.round((selectedZone.opacity ?? 0.2) * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={0.9}
                      step={0.05}
                      value={selectedZone.opacity ?? 0.2}
                      onChange={e => updateZone(selectedZone.id, { opacity: Number(e.target.value) })}
                      className="w-full accent-primary"
                    />
                  </div>

                  {/* Vertex hint */}
                  <div className="rounded-md bg-[#202932] border border-[#3a424b] p-2.5">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      <span className="font-semibold text-foreground">Drag</span> a white corner handle to move that point.<br/>
                      <span className="font-semibold text-foreground">Click</span> a small dot on an edge to add a new point there.<br/>
                      <span className="font-semibold text-foreground">Double-click</span> a corner handle to remove it.
                    </p>
                  </div>
                </div>

                {/* Footer */}
                <div className="p-3 border-t border-[#3a424b]">
                  <button
                    onClick={() => {
                      if (selectedZone.linkedLevelId != null) {
                        setConfirmDelete({
                          message: `Permanently delete zone "${selectedZone.name || ''}"? This also removes it from GarageLevels on the Google Sheet.`,
                          action: () => deleteZone(selectedZone.id),
                        });
                        return;
                      }
                      deleteZone(selectedZone.id);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-destructive/10 hover:bg-destructive/20 text-destructive text-xs font-medium cursor-pointer transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Zone
                  </button>
                </div>
              </MotionDiv>
            )}
          </>
        )}

        {activeTab === 'config' && (
          <Suspense fallback={
            <div className="flex items-center justify-center h-64 text-sm text-[#adb5bd] bg-[#1d242c]">
              Loading config editor…
            </div>
          }>
            <ConfigEditor sites={sites} />
          </Suspense>
        )}
      </div>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <MotionDiv
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-foreground text-background text-sm font-medium shadow-lg"
            role="status"
            aria-live="polite"
          >
            {toast}
          </MotionDiv>
        )}
      </AnimatePresence>

      <AppSettingsDialog open={showAppSettings} onOpenChange={setShowAppSettings} />
      <ReportIssueDialog open={showReportIssue} onOpenChange={setShowReportIssue} />

      {/* Level Settings Dialog */}
      <Dialog open={showSettingsModal} onOpenChange={setShowSettingsModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Level Settings</DialogTitle>
            <DialogDescription>Update level details and optionally quick-add devices.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Level Name</Label>
              <Input value={settingsForm.name || ''} onChange={e => setSettingsForm(f => ({ ...f, name: e.target.value }))} className="mt-1.5" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Total Spots</Label>
                <Input type="number" value={settingsForm.totalSpots || 0} onChange={e => setSettingsForm(f => ({ ...f, totalSpots: e.target.value }))} className="mt-1.5" />
              </div>
              <div>
                <Label>EV Spots</Label>
                <Input type="number" value={settingsForm.evSpots || 0} onChange={e => setSettingsForm(f => ({ ...f, evSpots: e.target.value }))} className="mt-1.5" />
              </div>
              <div>
                <Label>ADA Spots</Label>
                <Input type="number" value={settingsForm.handicapSpots || 0} onChange={e => setSettingsForm(f => ({ ...f, handicapSpots: e.target.value }))} className="mt-1.5" />
              </div>
            </div>

            {/* Quick-add devices (collapsible per category) */}
            <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/40">
                <div className="flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5 text-primary" />
                  <span className="text-sm font-medium">Quick-add devices</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {bulkSummary.total > 0 && (
                    <Badge variant="secondary" className="text-[10px]">+{bulkSummary.total} unplaced</Badge>
                  )}
                  {bulkSummary.total > 0 && (
                    <button
                      type="button"
                      onClick={() => setBulkCounts(makeEmptyBulkCounts())}
                      className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground px-3 pt-2 leading-snug">
                Pre-create devices with auto IDs (S1.1 / 1.1F / 1.1NW…). They show up as Unplaced — click Place on map, then click the canvas to set their position.
              </p>
              <div className="divide-y divide-border">
                {BULK_CATEGORIES.map(cat => {
                  const Icon = cat.icon;
                  const isOpen = expandedCategory === cat.id;
                  const catCount = bulkSummary.perCat[cat.id] || 0;
                  return (
                    <div key={cat.id}>
                      <button
                        type="button"
                        onClick={() => setExpandedCategory(isOpen ? null : cat.id)}
                        className="w-full flex items-center justify-between px-3 py-2 hover:bg-accent/40 cursor-pointer text-left"
                      >
                        <div className="flex items-center gap-2">
                          <Icon className={`w-4 h-4 ${cat.accent}`} />
                          <span className="text-sm font-medium">{cat.label}</span>
                          {catCount > 0 && (
                            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">+{catCount}</Badge>
                          )}
                        </div>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <MotionDiv
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            className="overflow-hidden"
                          >
                            <div className={`grid gap-2 p-3 pt-2 ${cat.items.length >= 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`}>
                              {cat.items.map(it => {
                                const value = bulkCounts[it.type] ?? 0;
                                const num = Math.max(0, parseInt(value, 10) || 0);
                                const setVal = (v) => setBulkCounts(b => ({ ...b, [it.type]: v }));
                                return (
                                  <div key={it.type} className="flex flex-col items-center gap-1.5 rounded-md bg-background border border-border p-2 min-w-0">
                                    <span className={`text-[10px] uppercase tracking-wide font-semibold ${it.color}`}>{it.label}</span>
                                    <div className="flex items-center gap-0.5 w-full justify-center">
                                      <button
                                        type="button"
                                        onClick={() => setVal(Math.max(0, num - 1))}
                                        className="shrink-0 w-5 h-6 rounded-md bg-muted hover:bg-accent text-sm font-medium cursor-pointer disabled:opacity-30 flex items-center justify-center"
                                        disabled={num <= 0}
                                        aria-label={`Decrease ${it.label}`}
                                      >−</button>
                                      <Input
                                        type="number" min={0} max={500}
                                        value={value}
                                        onChange={e => setVal(e.target.value)}
                                        onFocus={e => e.target.select()}
                                        className="h-6 w-9 min-w-0 text-center px-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [&::-webkit-outer-spin-button]:m-0"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => setVal(num + 1)}
                                        className="shrink-0 w-5 h-6 rounded-md bg-muted hover:bg-accent text-sm font-medium cursor-pointer flex items-center justify-center"
                                        aria-label={`Increase ${it.label}`}
                                      >+</button>
                                    </div>
                                    <span className="text-[9px] text-muted-foreground truncate max-w-full">{it.prefix}1, {it.prefix}2…</span>
                                  </div>
                                );
                              })}
                            </div>
                          </MotionDiv>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSettingsModal(false)}>Cancel</Button>
            <Button onClick={saveSettings}>
              {bulkSummary.total > 0 ? `Save & Add ${bulkSummary.total} Device${bulkSummary.total === 1 ? '' : 's'}` : 'Save Settings'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Camera Wizard */}
      <AddCameraWizard
        open={showCameraWizard}
        onOpenChange={setShowCameraWizard}
        initialStreamType={wizardCameraType}
        levels={levels}
        currentLevel={currentLevel}
        servers={site?.servers || []}
        onAddCamera={handleAddCameraFromWizard}
      />

      {/* Delete / unplace confirmation */}
      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm</DialogTitle>
            <DialogDescription>{confirmDelete?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                try {
                  await confirmDelete?.action();
                  setConfirmDelete(null);
                } catch (err) {
                  showToast(`Action failed: ${err.message}`, { duration: 5000 });
                  setConfirmDelete(null);
                }
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Multi-page PDF floor plan picker */}
      <Dialog open={!!pdfPagePrompt} onOpenChange={(open) => { if (!open) setPdfPagePrompt(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>PDF page</DialogTitle>
            <DialogDescription>
              This PDF has {pdfPagePrompt?.pageCount} pages. Page 1 is already applied — pick another page if needed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2 py-2">
            {pdfPagePrompt && Array.from({ length: pdfPagePrompt.pageCount }, (_, i) => i + 1).map((n) => (
              <Button
                key={n}
                type="button"
                size="sm"
                variant="outline"
                disabled={bgUploading}
                onClick={() => handlePdfPageConfirm(n)}
              >
                Page {n}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPdfPagePrompt(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
