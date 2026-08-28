import React, { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore, useCurrentSite, useCurrentCustomer, useCustomerSites } from '../stores/useAppStore';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';
import { Switch } from './ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from './ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import ContactsSidebar from './ContactsSidebar';
import Weather from './Weather';
import SetupSyncIndicator from './SetupSyncIndicator';
import { customerLocationFields } from '../lib/customerUtils';
import {
  defaultLevelSheetConfig, defaultDisplayGroup, defaultSensorGroup,
  DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS, ensureDeviceSensorGroup,
} from '../lib/configSheetSchema';
import { countSiteDevices } from '../lib/deviceCountUtils';
import { getLevelNamingNumber } from '../lib/deviceNamingUtils';
import { LOGICAL_H, LOGICAL_W } from '../lib/canvasConstants';
import {
  ZONE_LEVEL_TYPE,
  ensureLinkedZonePolygon,
  floorLevels,
  isDuplicateZoneName,
  isZoneLevel,
  nextZoneLevelName,
  removeLinkedZonePolygons,
  zoneLevels,
  zoneSheetLevelName,
} from '../lib/zoneLevelUtils';
import { DeviceIcon } from './DeviceIcons';
import {
  Plus, Pencil, Trash2, Home, Layers, ChevronRight,
  Server, Monitor, HardDrive, Network,
  Camera, MonitorSpeaker, Radio, Eye, EyeOff, ChevronDown, Shapes,
} from 'lucide-react';

const DEVICE_TYPE_LABELS = {
  'cam-fli': 'FLI', 'cam-lpr': 'LPR', 'cam-people': 'People',
  'sign-led': 'LED', 'sign-static': 'Static', 'sign-designable': 'Designable',
  'sensor-nwave': 'NWAVE', 'sensor-parksol': 'Parksol', 'sensor-proco': 'Proco', 'sensor-ensight': 'Ensight',
};
const DEVICE_TYPE_COLORS = {
  'cam-fli': '#3b82f6', 'cam-lpr': '#8b5cf6', 'cam-people': '#06b6d4',
  'sign-led': '#f59e0b', 'sign-static': '#eab308', 'sign-designable': '#f97316',
  'sensor-nwave': '#10b981', 'sensor-parksol': '#14b8a6', 'sensor-proco': '#22c55e', 'sensor-ensight': '#34d399',
};

const MotionDiv = motion.div;

const SERVER_TYPES = [
  { id: 'epic', name: 'EPIC Server' },
  { id: 'fli', name: 'FLI Server' },
  { id: 'camerahub', name: 'CameraHub Server' },
  { id: 'other', name: 'Other' },
];

const OS_OPTIONS = ['Linux', 'Ubuntu', 'Windows'];

const MODEL_OPTIONS = ['FLIv2', 'FLIv2 Edge'];

const DEFAULT_PORT = { mac: '', ip: '', dhcp: false };

function hasLocationFields(location) {
  return Boolean(
    location?.address || location?.city || location?.state || location?.zip || location?.mapsUrl
  );
}

/** Prefer site fields; otherwise use normalized customer.config location. */
function effectiveLocation(site, customer) {
  if (hasLocationFields(site)) return site;
  return customerLocationFields(customer);
}

function formatSiteAddress(location) {
  return [location?.address, location?.city, location?.state, location?.zip].filter(Boolean).join(', ');
}

// Categories for the bulk-add picker used in the Add/Edit Level dialog.
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
    icon: MonitorSpeaker,
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

function makeBulkDevice(type, prefix, name) {
  const base = {
    type,
    name,
    friendlyName: '',
    x: 0, y: 0, rotation: 0,
    pendingPlacement: true,
    serverId: null,
    dhcp: false,
  };
  if (type.startsWith('cam-')) {
    return {
      ...base,
      hardwareType: 'bullet',
      stream1: { ipAddress: '0.0.0.0', port: '554', externalUrl: '', streamType: type },
      ipAddress: '0.0.0.0', port: '554',
      trafficFlow: { direction: '', destinations: [] },
    };
  }
  if (type.startsWith('sign-')) {
    return { ...base, ipAddress: '', port: '' };
  }
  if (type.startsWith('sensor-')) {
    return {
      ...base,
      sensorGroup: type,
      sensorCount: 1,
      apiKey: type === 'sensor-nwave' ? '' : undefined,
    };
  }
  return base;
}

const SENSOR_PROTOCOL_OPTIONS = ['NWAVE', 'Parksol', 'Proco', 'Ensight'];

function makeEmptyBulkCounts() {
  const o = {};
  BULK_CATEGORIES.forEach(c => c.items.forEach(it => { o[it.type] = 0; }));
  return o;
}

// Cameras get level-aware short IDs: F11/F12... on level 1, F21/F22... on level 2, etc.
const CAMERA_TYPES_SET = new Set(['cam-fli', 'cam-lpr', 'cam-people']);
function isCameraType(t) { return CAMERA_TYPES_SET.has(t); }

export default function LevelSelector() {
  const site = useCurrentSite();
  const currentCustomer = useCurrentCustomer();
  const sites = useCustomerSites();
  const { setSites, setLevels, selectLevel, goHome } = useAppStore();

  const siteLocation = effectiveLocation(site, currentCustomer);
  const siteAddress = formatSiteAddress(siteLocation);

  const levels = useMemo(() => site?.levels || [], [site?.levels]);
  const servers = useMemo(() => site?.servers || [], [site?.servers]);
  const floorLevelList = useMemo(() => floorLevels(levels), [levels]);
  const zoneLevelList = useMemo(() => zoneLevels(levels), [levels]);
  const displayGroups = site?.displayGroups || [];
  const sensorGroups = site?.sensorGroups || [];

  const [showLevelModal, setShowLevelModal] = useState(false);
  const [editLevel, setEditLevel] = useState(null);
  const [levelForm, setLevelForm] = useState({
    name: '',
    totalSpots: 100,
    evSpots: 0,
    handicapSpots: 0,
    isZone: false,
    parentLevelId: null,
  });
  const [bulkCounts, setBulkCounts] = useState(() => makeEmptyBulkCounts());
  const [expandedCategory, setExpandedCategory] = useState(null);
  const [savingLevel, setSavingLevel] = useState(false);
  const [levelSyncError, setLevelSyncError] = useState('');
  const [viewSyncError, setViewSyncError] = useState('');
  const [serverSyncError, setServerSyncError] = useState('');
  const [savingServer, setSavingServer] = useState(false);

  const [showServerModal, setShowServerModal] = useState(false);
  const [editServer, setEditServer] = useState(null);
  const [showSplashtopPw, setShowSplashtopPw] = useState(false);
  const [serverForm, setServerForm] = useState({
    name: '', type: 'epic', os: 'Windows',
    model: '',
    ports: [{ ...DEFAULT_PORT }],
    splashtopUser: 'Administrator', splashtopPassword: '', splashtopUrl: '',
    notes: '',
  });

  const [showDisplayGroupModal, setShowDisplayGroupModal] = useState(false);
  const [editDisplayGroup, setEditDisplayGroup] = useState(null);
  const [displayGroupForm, setDisplayGroupForm] = useState({
    name: '', sendOnlyOnUpdates: false, forceSendAfterSeconds: DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS,
  });
  const [showSensorGroupModal, setShowSensorGroupModal] = useState(false);
  const [editSensorGroup, setEditSensorGroup] = useState(null);
  const [sensorGroupForm, setSensorGroupForm] = useState({
    groupId: '', controllerAddress: '', controllerKey: '', sensorProtocol: 'NWAVE', parentLevel: '',
  });
  const [groupSyncError, setGroupSyncError] = useState('');

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

  const buildBulkDevices = useCallback((existingDevices, namingLevel) => {
    const out = [];
    const usedNames = new Set(existingDevices.map(d => d.name));
    BULK_CATEGORIES.forEach(cat => {
      cat.items.forEach(it => {
        const count = Math.max(0, parseInt(bulkCounts[it.type], 10) || 0);
        const isCam = isCameraType(it.type);
        const isSign = it.type.startsWith('sign-');
        // Cameras use {level}.{seq}{prefix}; signs S{level}.{seq}; sensors {prefix}{seq}.
        const buildName = (seq) => {
          if (isSign) return `S${namingLevel}.${seq}`;
          if (isCam) return `${namingLevel}.${seq}${it.prefix}`;
          return `${it.prefix}${seq}`;
        };
        let n = 1;
        for (let i = 0; i < count; i++) {
          let name = buildName(n);
          while (usedNames.has(name)) {
            n++;
            name = buildName(n);
          }
          usedNames.add(name);
          out.push({ id: crypto.randomUUID(), ...makeBulkDevice(it.type, it.prefix, name) });
          n++;
        }
      });
    });
    return out;
  }, [bulkCounts]);

  const handleSaveLevel = useCallback(async () => {
    if (!levelForm.name.trim() || savingLevel || !site) return;
    if (levelForm.isZone && levelForm.parentLevelId == null) {
      setLevelSyncError('Pick a parent level for this zone.');
      return;
    }
    if (
      levelForm.isZone
      && isDuplicateZoneName(levelForm.name, levelForm.parentLevelId, levels, editLevel?.id ?? null)
    ) {
      setLevelSyncError(`A zone named "${levelForm.name.trim()}" already exists on this level.`);
      return;
    }
    setLevelSyncError('');
    setViewSyncError('');
    setSavingLevel(true);

    const makingZone = !!levelForm.isZone;
    const parentLevelId = makingZone ? levelForm.parentLevelId : null;
    const levelName = levelForm.name.trim();
    let nextLevels;
    let bulk = [];
    let targetLevelId;

    if (editLevel) {
      const existing = editLevel.devices || [];
      if (makingZone && existing.length > 0) {
        setLevelSyncError('Remove cameras, signs, and sensors before converting this level to a zone.');
        setSavingLevel(false);
        return;
      }
      bulk = makingZone ? [] : buildBulkDevices(existing, getLevelNamingNumber(editLevel, levels));
      targetLevelId = editLevel.id;
      nextLevels = levels.map((l, index) => {
        if (l.id !== editLevel.id) return l;
        const ordinal = index + 1;
        const baseConfig = { ...defaultLevelSheetConfig(ordinal), ...(l.config || {}) };
        return {
          ...l,
          name: levelName,
          internalName: levelName,
          totalSpots: Number(levelForm.totalSpots),
          evSpots: Number(levelForm.evSpots),
          handicapSpots: Number(levelForm.handicapSpots),
          isZone: makingZone,
          parentLevelId: makingZone ? parentLevelId : null,
          config: {
            ...baseConfig,
            // Sheet LevelType is FLI for zones; app uses isZone + parentLevelId.
            levelType: makingZone
              ? 'FLI'
              : (baseConfig.levelType === ZONE_LEVEL_TYPE ? 'FLI' : (baseConfig.levelType || 'FLI')),
          },
          devices: makingZone ? [] : (bulk.length ? [...existing, ...bulk] : existing),
        };
      });
      if (makingZone) {
        const zoneLevel = nextLevels.find((l) => l.id === targetLevelId);
        nextLevels = ensureLinkedZonePolygon(nextLevels, zoneLevel, parentLevelId, {
          logicalW: LOGICAL_W,
          logicalH: LOGICAL_H,
        });
      } else if (isZoneLevel(editLevel)) {
        nextLevels = removeLinkedZonePolygons(nextLevels, editLevel.id);
      }
    } else {
      const newId = crypto.randomUUID();
      const ordinal = levels.length + 1;
      bulk = makingZone ? [] : buildBulkDevices([], ordinal);
      targetLevelId = newId;
      const config = {
        ...defaultLevelSheetConfig(ordinal),
        levelType: 'FLI',
      };
      const newLevel = {
        id: newId,
        name: levelName,
        internalName: levelName,
        totalSpots: Number(levelForm.totalSpots),
        evSpots: Number(levelForm.evSpots),
        handicapSpots: Number(levelForm.handicapSpots),
        bgImage: null,
        devices: bulk,
        zones: [],
        isZone: makingZone,
        parentLevelId: makingZone ? parentLevelId : null,
        config,
      };
      nextLevels = [...levels, newLevel];
      if (makingZone) {
        nextLevels = ensureLinkedZonePolygon(nextLevels, newLevel, parentLevelId, {
          logicalW: LOGICAL_W,
          logicalH: LOGICAL_H,
        });
      }
    }

    // Bulk-added sensors need a site sensor group — assign or create one
    // locally (this used to happen inside the sheet-sync path). The store's
    // debounced auto-save then persists the whole tree to Supabase.
    const sensorBulk = bulk.filter((d) => d.type?.startsWith('sensor-'));
    let siteAfterSave = { ...site, levels: nextLevels };
    for (const device of sensorBulk) {
      const targetLevel = (siteAfterSave.levels || []).find((l) => l.id === targetLevelId);
      siteAfterSave = ensureDeviceSensorGroup(siteAfterSave, targetLevel, device).site;
    }

    if (sensorBulk.length) {
      setSites(sites.map((s) => (s.id === site.id ? siteAfterSave : s)));
    } else {
      setLevels(nextLevels);
    }

    setShowLevelModal(false);
    setEditLevel(null);
    setBulkCounts(makeEmptyBulkCounts());
    setExpandedCategory(null);
    setSavingLevel(false);
  }, [levelForm, editLevel, levels, setLevels, setSites, buildBulkDevices, site, savingLevel, sites]);

  const [confirmDelete, setConfirmDelete] = useState(null);

  const handleDeleteLevel = useCallback((id) => {
    const l = levels.find(level => level.id === id);
    if (!l || !site) return;
    setConfirmDelete({
      message: isZoneLevel(l)
        ? `Delete zone "${l?.name || ''}"? Its polygon on the parent floor will be removed.`
        : `Delete level "${l?.name || ''}" and all its devices?`,
      action: async () => {
        let nextLevels = levels.filter(level => level.id !== id);
        if (isZoneLevel(l)) {
          nextLevels = removeLinkedZonePolygons(nextLevels, id);
        } else {
          // Drop zone-levels that belonged to this floor.
          const orphanZoneIds = nextLevels
            .filter((z) => isZoneLevel(z) && String(z.parentLevelId) === String(id))
            .map((z) => z.id);
          nextLevels = nextLevels.filter((z) => !orphanZoneIds.includes(z.id));
          for (const zid of orphanZoneIds) {
            nextLevels = removeLinkedZonePolygons(nextLevels, zid);
          }
        }
        setLevels(nextLevels);
      },
    });
  }, [levels, setLevels, site]);

  const handleSaveServer = useCallback(async () => {
    if (!serverForm.name.trim() || savingServer || !site) return;
    const targetName = serverForm.name.trim().toLowerCase();
    const isDuplicateServerName = (site.servers || []).some((sv) => (
      sv.id !== editServer?.id && String(sv.name || '').trim().toLowerCase() === targetName
    ));
    if (isDuplicateServerName) {
      setServerSyncError(`A server named "${serverForm.name.trim()}" already exists on this site.`);
      return;
    }
    setServerSyncError('');
    setViewSyncError('');
    setSavingServer(true);

    const updatedSites = sites.map(s => {
      if (s.id !== site.id) return s;
      const srvs = s.servers || [];
      if (editServer) {
        return { ...s, servers: srvs.map(sv => sv.id === editServer.id ? { ...sv, ...serverForm } : sv) };
      }
      const newId = crypto.randomUUID();
      return { ...s, servers: [...srvs, { id: newId, ...serverForm }] };
    });
    setSites(updatedSites);

    setShowServerModal(false);
    setEditServer(null);
    setSavingServer(false);
  }, [serverForm, editServer, site, sites, setSites, savingServer]);

  const handleDeleteServer = useCallback((id) => {
    const s = (site.servers || []).find(s => s.id === id);
    setConfirmDelete({
      message: `Delete server "${s?.name || ''}"?`,
      action: async () => {
        const nextSite = {
          ...site,
          servers: (site.servers || []).filter((srv) => srv.id !== id),
        };
        setSites(sites.map((s) => (s.id === site.id ? nextSite : s)));
      },
    });
  }, [site, sites, setSites]);

  const updateSiteGroups = useCallback((patch) => {
    setSites(sites.map((s) => (s.id === site.id ? { ...s, ...patch } : s)));
  }, [site, sites, setSites]);

  const handleSaveDisplayGroup = useCallback(async () => {
    if (!displayGroupForm.name.trim() || !site) return;
    const targetName = displayGroupForm.name.trim().toLowerCase();
    const isDuplicateName = (site.displayGroups || []).some((g) => (
      g.id !== editDisplayGroup?.id && String(g.name || '').trim().toLowerCase() === targetName
    ));
    if (isDuplicateName) {
      setGroupSyncError(`A display group named "${displayGroupForm.name.trim()}" already exists on this site.`);
      return;
    }
    setGroupSyncError('');

    const groups = site.displayGroups || [];
    let nextGroups;
    if (editDisplayGroup) {
      nextGroups = groups.map((g) => (
        g.id === editDisplayGroup.id ? { ...g, ...displayGroupForm } : g
      ));
    } else {
      const newId = crypto.randomUUID();
      nextGroups = [...groups, defaultDisplayGroup(newId, displayGroupForm.name.trim())];
      const created = nextGroups[nextGroups.length - 1];
      Object.assign(created, {
        sendOnlyOnUpdates: displayGroupForm.sendOnlyOnUpdates,
        forceSendAfterSeconds: Number(displayGroupForm.forceSendAfterSeconds) || DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS,
      });
    }

    updateSiteGroups({ displayGroups: nextGroups });
    setShowDisplayGroupModal(false);
    setEditDisplayGroup(null);
  }, [displayGroupForm, editDisplayGroup, site, updateSiteGroups]);

  const handleDeleteDisplayGroup = useCallback((id) => {
    const g = (site.displayGroups || []).find((grp) => grp.id === id);
    setConfirmDelete({
      message: `Delete display group "${g?.name || ''}"? Signs assigned to it will be unassigned.`,
      action: async () => {
        const nextGroups = (site.displayGroups || []).filter((grp) => grp.id !== id);
        const nextLevels = (site.levels || []).map((level) => ({
          ...level,
          devices: (level.devices || []).map((d) => (
            d.displayGroupId === id ? { ...d, displayGroupId: null, displayGroupName: '' } : d
          )),
        }));
        const nextSite = { ...site, displayGroups: nextGroups, levels: nextLevels };
        setSites(sites.map((s) => (s.id === site.id ? nextSite : s)));
      },
    });
  }, [site, sites, setSites]);

  const handleSaveSensorGroup = useCallback(async () => {
    if (!sensorGroupForm.groupId.trim() || !site) return;
    const targetGroupId = sensorGroupForm.groupId.trim().toLowerCase();
    const isDuplicateGroupId = (site.sensorGroups || []).some((g) => (
      g.id !== editSensorGroup?.id && String(g.groupId || '').trim().toLowerCase() === targetGroupId
    ));
    if (isDuplicateGroupId) {
      setGroupSyncError(`A sensor group named "${sensorGroupForm.groupId.trim()}" already exists on this site.`);
      return;
    }
    setGroupSyncError('');

    const groups = site.sensorGroups || [];
    let nextGroups;
    if (editSensorGroup) {
      nextGroups = groups.map((g) => (
        g.id === editSensorGroup.id ? { ...g, ...sensorGroupForm } : g
      ));
    } else {
      const newId = crypto.randomUUID();
      nextGroups = [...groups, defaultSensorGroup(newId, sensorGroupForm.groupId.trim())];
      const created = nextGroups[nextGroups.length - 1];
      Object.assign(created, {
        controllerAddress: sensorGroupForm.controllerAddress,
        controllerKey: sensorGroupForm.controllerKey,
        sensorProtocol: sensorGroupForm.sensorProtocol,
        parentLevel: sensorGroupForm.parentLevel,
      });
    }

    updateSiteGroups({ sensorGroups: nextGroups });
    setShowSensorGroupModal(false);
    setEditSensorGroup(null);
  }, [sensorGroupForm, editSensorGroup, site, updateSiteGroups]);

  const handleDeleteSensorGroup = useCallback((id) => {
    const g = (site.sensorGroups || []).find((grp) => grp.id === id);
    setConfirmDelete({
      message: `Delete sensor group "${g?.groupId || ''}"? Sensors assigned to it will be unassigned.`,
      action: async () => {
        const nextGroups = (site.sensorGroups || []).filter((grp) => grp.id !== id);
        const nextLevels = (site.levels || []).map((level) => ({
          ...level,
          devices: (level.devices || []).map((d) => (
            d.configSensorGroupId === id ? { ...d, configSensorGroupId: null } : d
          )),
        }));
        const nextSite = { ...site, sensorGroups: nextGroups, levels: nextLevels };
        setSites(sites.map((s) => (s.id === site.id ? nextSite : s)));
      },
    });
  }, [site, sites, setSites]);

  const handleUpdateContacts = useCallback((contacts) => {
    setSites(sites.map(s => s.id === site.id ? { ...s, contacts } : s));
  }, [site, sites, setSites]);

  const totalDevices = useMemo(() => countSiteDevices(site), [site]);
  const totalSpots = useMemo(
    () => floorLevelList.reduce((s, l) => s + (l.totalSpots || 0), 0),
    [floorLevelList],
  );

  if (!site) return null;

  return (
    <div className="levels-page min-h-screen flex overflow-x-hidden overscroll-x-none bg-[#1d242c] text-white">
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <header className="h-14 border-b border-[#495057] bg-[#151c23] flex items-center justify-between px-6 shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={goHome}
              className="p-1.5 rounded-md text-[#949494] hover:bg-[#282e35] hover:text-white cursor-pointer transition-colors"
              title="Home — Customers"
              aria-label="Home — Customers"
            >
              <Home className="w-4 h-4" />
            </button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-[19px] font-extrabold tracking-[0.2px]">Levels</h1>
                <span className="rounded border border-[#495057] bg-[#282e35] px-2.5 py-1 text-[10px] font-semibold text-[#adb5bd]">{site?.name}</span>
                {currentCustomer?.friendlyName && <span className="text-[10px] text-[#6c757d]">{currentCustomer.friendlyName}</span>}
              </div>
              {siteAddress && (
                <p className="mt-0.5 max-w-[420px] truncate text-[10px] text-[#6c757d]">
                  {siteAddress}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ContactsSidebar
              contacts={site.contacts}
              siteName={site.name}
              onUpdateContacts={handleUpdateContacts}
            />
            <SetupSyncIndicator />
            {siteAddress && (
              <Weather address={siteAddress} />
            )}
          </div>
        </header>

        {/* Content — overflow-x-hidden so Chrome doesn't steal mouse Back for horizontal scroll */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-7 py-6">
          {viewSyncError && (
            <div className="mb-4 max-w-5xl mx-auto flex items-start gap-3 p-3 rounded-xl border border-destructive/30 bg-destructive/5">
              <p className="flex-1 text-sm text-destructive">{viewSyncError}</p>
              <button
                type="button"
                onClick={() => setViewSyncError('')}
                className="text-xs text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}
          <section className="mb-5 flex flex-wrap items-center gap-y-2 border-y border-[#3a424b] bg-[#20272f]/45 px-1 py-2" aria-label="Level totals">
            {[
              ['Levels', floorLevelList.length, '#49b6d6'],
              ['Zones', zoneLevelList.length, '#f59c1a'],
              ['Spots', totalSpots, '#348fe2'],
              ['Devices', totalDevices, '#ffffff'],
              ['Servers', servers.length, '#adb5bd'],
              ['Display Groups', displayGroups.length, '#f59c1a'],
              ['Sensor Groups', sensorGroups.length, '#00acac'],
            ].map(([label, value, color], index) => (
              <div key={label} className={`flex min-w-[118px] items-center gap-2.5 px-4 py-1.5 ${index > 0 ? 'border-l border-[#3a424b]' : ''}`}>
                <span className="h-6 w-[3px] rounded-full" style={{ backgroundColor: color }} />
                <div>
                  <div className="text-[20px] font-bold leading-none tabular-nums text-white">{value}</div>
                  <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-[#949494]">{label}</div>
                </div>
              </div>
            ))}
          </section>

          <Tabs defaultValue="levels">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[5px] border border-[#3a424b] bg-[#20272f] px-3 py-2">
              <TabsList className="h-auto flex-wrap justify-start bg-[#151c23]">
                <TabsTrigger value="levels" className="text-[11px] data-[state=active]:bg-[#282e35] data-[state=active]:text-white">
                  <Layers className="w-4 h-4 mr-1.5" /> Levels
                </TabsTrigger>
                <TabsTrigger value="zones" className="text-[11px] data-[state=active]:bg-[#282e35] data-[state=active]:text-white">
                  <Shapes className="w-4 h-4 mr-1.5" /> Zones
                </TabsTrigger>
                <TabsTrigger value="servers" className="text-[11px] data-[state=active]:bg-[#282e35] data-[state=active]:text-white">
                  <Server className="w-4 h-4 mr-1.5" /> Servers
                </TabsTrigger>
                <TabsTrigger value="display-groups" className="text-[11px] data-[state=active]:bg-[#282e35] data-[state=active]:text-white">
                  <MonitorSpeaker className="w-4 h-4 mr-1.5" /> Display Groups
                </TabsTrigger>
                <TabsTrigger value="sensor-groups" className="text-[11px] data-[state=active]:bg-[#282e35] data-[state=active]:text-white">
                  <Radio className="w-4 h-4 mr-1.5" /> Sensor Groups
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Levels Tab */}
            <TabsContent value="levels">
              <div className="flex justify-end mb-4">
                <Button className="h-[30px] rounded-[5px] bg-white px-4 text-[11px] font-bold text-[#151c23] hover:bg-[#e9ecef]" onClick={() => {
                  setLevelForm({
                    name: '',
                    totalSpots: 100,
                    evSpots: 0,
                    handicapSpots: 0,
                    isZone: false,
                    parentLevelId: null,
                  });
                  setBulkCounts(makeEmptyBulkCounts());
                  setExpandedCategory(null);
                  setEditLevel(null);
                  setLevelSyncError('');
                  setShowLevelModal(true);
                }}>
                  <Plus className="w-4 h-4" /> Add Level
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                <AnimatePresence>
                  {floorLevelList.map((level, i) => (
                    <MotionDiv
                      key={level.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ delay: i * 0.05 }}
                    >
                      <Card
                        className="group cursor-pointer overflow-hidden rounded-xl border-[#3a424b] bg-[#282e35] text-white shadow-[0_.125rem_.25rem_rgba(0,0,0,.3)] transition-all duration-200 hover:border-[#495057] hover:shadow-[0_.5rem_1rem_rgba(0,0,0,.35)]"
                        onClick={() => selectLevel(level.id)}
                      >
                        <div className="flex items-center justify-between border-b border-[#3a424b] px-4 py-3">
                            <h3 className="text-[15px] font-bold transition-colors group-hover:text-[#49b6d6]">{level.name}</h3>
                            <Badge variant="outline" className="border-[#495057] bg-[#1d242c] text-[9px] text-[#adb5bd]">
                              {level.devices?.length || 0} devices
                            </Badge>
                        </div>
                        <CardContent className="p-4">
                          <div className="mb-3 grid grid-cols-3 overflow-hidden rounded-[5px] border border-[#3a424b] bg-[#20272f]">
                            <div className="border-r border-[#3a424b] p-2 text-center">
                              <p className="text-[15px] font-bold">{level.totalSpots || 0}</p>
                              <p className="text-[9px] text-[#949494] uppercase tracking-wide">Total</p>
                            </div>
                            <div className="border-r border-[#3a424b] p-2 text-center">
                              <p className="text-[15px] font-bold text-[#00acac]">{level.evSpots || 0}</p>
                              <p className="text-[9px] text-[#949494] uppercase tracking-wide">EV</p>
                            </div>
                            <div className="p-2 text-center">
                              <p className="text-[15px] font-bold text-[#49b6d6]">{level.handicapSpots || 0}</p>
                              <p className="text-[9px] text-[#949494] uppercase tracking-wide">ADA</p>
                            </div>
                          </div>

                          {/* Device breakdown */}
                          {(level.devices?.length || 0) > 0 && (() => {
                            const devs = level.devices || [];
                            const typeCounts = {};
                            devs.forEach(d => { if (d.type) typeCounts[d.type] = (typeCounts[d.type] || 0) + 1; });
                            return (
                              <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[#949494]">
                                {Object.entries(typeCounts).map(([type, count]) => (
                                  <span key={type} className="flex items-center gap-1">
                                    <DeviceIcon type={type} className="w-3 h-3" style={{ color: DEVICE_TYPE_COLORS[type] || '#6b7280' }} />
                                    {count} {DEVICE_TYPE_LABELS[type] || type}
                                  </span>
                                ))}
                              </div>
                            );
                          })()}

                          <div className="flex items-center justify-between border-t border-[#3a424b] pt-2" onClick={e => e.stopPropagation()}>
                            <div className="flex gap-1">
                              <button onClick={() => {
                                setLevelForm({
                                  name: level.name,
                                  totalSpots: level.totalSpots,
                                  evSpots: level.evSpots,
                                  handicapSpots: level.handicapSpots,
                                  isZone: false,
                                  parentLevelId: null,
                                });
                                setBulkCounts(makeEmptyBulkCounts());
                                setExpandedCategory(null);
                                setEditLevel(level);
                                setLevelSyncError('');
                                setShowLevelModal(true);
                              }} className="p-1.5 rounded-md text-[#949494] hover:bg-[#1d242c] hover:text-white cursor-pointer">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => handleDeleteLevel(level.id)} className="p-1.5 rounded-md hover:bg-[#ff5b57]/10 cursor-pointer">
                                <Trash2 className="w-3.5 h-3.5 text-[#ff5b57]" />
                              </button>
                            </div>
                            <button
                              onClick={() => selectLevel(level.id)}
                              className="flex cursor-pointer items-center gap-1 text-[11px] font-bold text-white transition-all hover:gap-2"
                            >
                              Edit Layout <ChevronRight className="w-3 h-3" />
                            </button>
                          </div>
                        </CardContent>
                      </Card>
                    </MotionDiv>
                  ))}
                </AnimatePresence>
              </div>
            </TabsContent>

            {/* Zones Tab — GarageLevels rows (LevelType = FLI; zone marked in SetupJson) */}
            <TabsContent value="zones">
              <div className="flex justify-end mb-4">
                <Button
                  className="h-[30px] rounded-[5px] bg-white px-4 text-[11px] font-bold text-[#151c23] hover:bg-[#e9ecef]"
                  disabled={floorLevelList.length === 0}
                  onClick={() => {
                    const parent = floorLevelList[0];
                    setLevelForm({
                      name: parent ? nextZoneLevelName(parent, levels) : '',
                      totalSpots: 100,
                      evSpots: 0,
                      handicapSpots: 0,
                      isZone: true,
                      parentLevelId: parent?.id ?? null,
                    });
                    setBulkCounts(makeEmptyBulkCounts());
                    setExpandedCategory(null);
                    setEditLevel(null);
                    setLevelSyncError('');
                    setShowLevelModal(true);
                  }}
                >
                  <Plus className="w-4 h-4" /> Add Zone
                </Button>
              </div>

              {floorLevelList.length === 0 && (
                <p className="text-sm text-[#949494] mb-4">Add a floor level first, then create zones under it.</p>
              )}

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                <AnimatePresence>
                  {zoneLevelList.map((level, i) => {
                    const parent = levels.find((l) => String(l.id) === String(level.parentLevelId));
                    return (
                      <MotionDiv
                        key={level.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ delay: i * 0.05 }}
                      >
                        <Card
                          className="group cursor-pointer overflow-hidden rounded-xl border-[#3a424b] bg-[#282e35] text-white shadow-[0_.125rem_.25rem_rgba(0,0,0,.3)] transition-all duration-200 hover:border-[#495057] hover:shadow-[0_.5rem_1rem_rgba(0,0,0,.35)]"
                          onClick={() => selectLevel(parent?.id ?? level.id)}
                        >
                          <div className="flex items-center justify-between border-b border-[#3a424b] px-4 py-3">
                            <h3 className="text-[15px] font-bold transition-colors group-hover:text-[#f59c1a]">{level.name}</h3>
                            <Badge variant="outline" className="border-[#495057] bg-[#1d242c] text-[9px] text-[#f59c1a]">
                              Zone
                            </Badge>
                          </div>
                          <CardContent className="p-4">
                            <p className="mb-3 text-[11px] text-[#949494]">
                              Parent: <span className="text-white">{parent?.name || '—'}</span>
                            </p>
                            <p className="mb-3 text-[10px] text-[#949494]">
                              Sheet: <span className="text-white">{zoneSheetLevelName(level, levels)}</span>
                            </p>
                            <div className="mb-3 grid grid-cols-3 overflow-hidden rounded-[5px] border border-[#3a424b] bg-[#20272f]">
                              <div className="border-r border-[#3a424b] p-2 text-center">
                                <p className="text-[15px] font-bold">{level.totalSpots || 0}</p>
                                <p className="text-[9px] text-[#949494] uppercase tracking-wide">Total</p>
                              </div>
                              <div className="border-r border-[#3a424b] p-2 text-center">
                                <p className="text-[15px] font-bold text-[#00acac]">{level.evSpots || 0}</p>
                                <p className="text-[9px] text-[#949494] uppercase tracking-wide">EV</p>
                              </div>
                              <div className="p-2 text-center">
                                <p className="text-[15px] font-bold text-[#49b6d6]">{level.handicapSpots || 0}</p>
                                <p className="text-[9px] text-[#949494] uppercase tracking-wide">ADA</p>
                              </div>
                            </div>
                            <p className="mb-3 text-[10px] text-[#949494]">
                              No cameras, signs, or sensors. Polygon lives on the parent floor plan.
                            </p>
                            <div className="flex items-center justify-between border-t border-[#3a424b] pt-2" onClick={e => e.stopPropagation()}>
                              <div className="flex gap-1">
                                <button
                                  onClick={() => {
                                    setLevelForm({
                                      name: level.name,
                                      totalSpots: level.totalSpots,
                                      evSpots: level.evSpots,
                                      handicapSpots: level.handicapSpots,
                                      isZone: true,
                                      parentLevelId: level.parentLevelId ?? null,
                                    });
                                    setBulkCounts(makeEmptyBulkCounts());
                                    setExpandedCategory(null);
                                    setEditLevel(level);
                                    setLevelSyncError('');
                                    setShowLevelModal(true);
                                  }}
                                  className="p-1.5 rounded-md text-[#949494] hover:bg-[#1d242c] hover:text-white cursor-pointer"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleDeleteLevel(level.id)}
                                  className="p-1.5 rounded-md text-[#949494] hover:bg-[#1d242c] hover:text-destructive cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <button
                                onClick={() => selectLevel(parent?.id ?? level.id)}
                                className="flex cursor-pointer items-center gap-1 text-[11px] font-bold text-white transition-all hover:gap-2"
                              >
                                Open parent <ChevronRight className="w-3 h-3" />
                              </button>
                            </div>
                          </CardContent>
                        </Card>
                      </MotionDiv>
                    );
                  })}
                </AnimatePresence>
              </div>
              {zoneLevelList.length === 0 && floorLevelList.length > 0 && (
                <p className="text-sm text-[#949494] mt-2">No zones yet. Add a zone or toggle “This is a zone” when creating a level.</p>
              )}
            </TabsContent>

            {/* Servers Tab */}
            <TabsContent value="servers">
              <div className="flex justify-end mb-4">
                <Button className="h-[30px] rounded-[5px] bg-white px-4 text-[11px] font-bold text-[#151c23] hover:bg-[#e9ecef]" onClick={() => {
                  setServerForm({ name: '', type: 'epic', os: 'Windows', model: '', ports: [{ ...DEFAULT_PORT }], splashtopUser: 'Administrator', splashtopPassword: '', splashtopUrl: '', notes: '' });
                  setEditServer(null);
                  setShowSplashtopPw(false);
                  setServerSyncError('');
                  setShowServerModal(true);
                }}>
                  <Plus className="w-4 h-4" /> Add Server
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                <AnimatePresence>
                  {servers.map((server, i) => (
                    <MotionDiv
                      key={server.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05 }}
                    >
                      <Card className="group rounded-xl border-[#3a424b] bg-[#282e35] text-white shadow-[0_.125rem_.25rem_rgba(0,0,0,.3)] transition-all hover:border-[#495057]">
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#3a424b] bg-[#1d242c]">
                                <Server className="w-4 h-4 text-[#49b6d6]" />
                              </div>
                              <div>
                                <p className="font-semibold text-sm">{server.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {SERVER_TYPES.find(t => t.id === server.type)?.name || server.type}
                                </p>
                              </div>
                            </div>
                            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => {
                                const formData = {
                                  ...server,
                                  ports: server.ports?.length
                                    ? server.ports
                                    : [{ mac: server.macAddress || '', ip: server.ipAddress || '', dhcp: false }],
                                  splashtopUser: server.splashtopUser || 'Administrator',
                                  splashtopUrl: server.splashtopUrl || '',
                                };
                                setServerForm(formData);
                                setEditServer(server);
                                setShowSplashtopPw(false);
                                setServerSyncError('');
                                setShowServerModal(true);
                              }} className="p-1.5 rounded-md text-[#949494] hover:bg-[#1d242c] hover:text-white cursor-pointer">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => handleDeleteServer(server.id)} className="p-1.5 rounded-md hover:bg-[#ff5b57]/10 cursor-pointer">
                                <Trash2 className="w-3.5 h-3.5 text-[#ff5b57]" />
                              </button>
                            </div>
                          </div>
                          {(server.ipAddress || server.ports?.[0]?.ip) && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2">
                              <Network className="w-3 h-3" />
                              <span className="font-mono">{server.ports?.[0]?.ip || server.ipAddress}</span>
                              {(server.ports?.length || 0) > 1 && (
                                <span className="text-muted-foreground/60">+{server.ports.length - 1} port{server.ports.length > 2 ? 's' : ''}</span>
                              )}
                            </div>
                          )}
                          {server.os && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                              <Monitor className="w-3 h-3" />
                              <span>{server.os}</span>
                            </div>
                          )}
                          {server.model && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                              <HardDrive className="w-3 h-3" />
                              <span>{server.model}</span>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </MotionDiv>
                  ))}
                </AnimatePresence>

                {servers.length === 0 && (
                  <div className="col-span-full py-12 flex flex-col items-center gap-3 text-muted-foreground">
                    <Server className="w-10 h-10 opacity-30" />
                    <p className="text-sm">No servers configured</p>
                    <p className="text-xs">Add servers to manage your infrastructure</p>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Display Groups Tab */}
            <TabsContent value="display-groups">
              <div className="flex justify-end mb-4">
                <Button className="h-[30px] rounded-[5px] bg-white px-4 text-[11px] font-bold text-[#151c23] hover:bg-[#e9ecef]" onClick={() => {
                  setDisplayGroupForm({ name: '', sendOnlyOnUpdates: false, forceSendAfterSeconds: DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS });
                  setEditDisplayGroup(null);
                  setGroupSyncError('');
                  setShowDisplayGroupModal(true);
                }}>
                  <Plus className="w-4 h-4" /> Add Display Group
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Display groups batch sign updates so controllers are not all polled at once (e.g. 10 groups × 10 signs).
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {displayGroups.map((group, i) => (
                  <MotionDiv
                    key={group.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                  >
                    <Card className="group rounded-xl border-[#3a424b] bg-[#282e35] text-white shadow-[0_.125rem_.25rem_rgba(0,0,0,.3)] transition-all hover:border-[#495057]">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                              <MonitorSpeaker className="w-4 h-4 text-amber-500" />
                            </div>
                            <div>
                              <p className="font-semibold text-sm">{group.name}</p>
                              <p className="text-xs text-muted-foreground">
                                Every {group.forceSendAfterSeconds ?? DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS}s
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => {
                              setDisplayGroupForm({
                                name: group.name || '',
                                sendOnlyOnUpdates: Boolean(group.sendOnlyOnUpdates),
                                forceSendAfterSeconds: group.forceSendAfterSeconds ?? DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS,
                              });
                              setEditDisplayGroup(group);
                              setGroupSyncError('');
                              setShowDisplayGroupModal(true);
                            }} className="p-1.5 rounded-md text-[#949494] hover:bg-[#1d242c] hover:text-white cursor-pointer">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleDeleteDisplayGroup(group.id)} className="p-1.5 rounded-md hover:bg-[#ff5b57]/10 cursor-pointer">
                              <Trash2 className="w-3.5 h-3.5 text-[#ff5b57]" />
                            </button>
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {group.sendOnlyOnUpdates ? 'Send only on updates' : 'Send on schedule'}
                        </div>
                      </CardContent>
                    </Card>
                  </MotionDiv>
                ))}
                {displayGroups.length === 0 && (
                  <div className="col-span-full py-12 flex flex-col items-center gap-3 text-muted-foreground">
                    <MonitorSpeaker className="w-10 h-10 opacity-30" />
                    <p className="text-sm">No display groups configured</p>
                    <p className="text-xs">Add groups to stagger sign update polling</p>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Sensor Groups Tab */}
            <TabsContent value="sensor-groups">
              <div className="flex justify-end mb-4">
                <Button className="h-[30px] rounded-[5px] bg-white px-4 text-[11px] font-bold text-[#151c23] hover:bg-[#e9ecef]" onClick={() => {
                  setSensorGroupForm({
                    groupId: '', controllerAddress: '', controllerKey: '',
                    sensorProtocol: 'NWAVE', parentLevel: '',
                  });
                  setEditSensorGroup(null);
                  setGroupSyncError('');
                  setShowSensorGroupModal(true);
                }}>
                  <Plus className="w-4 h-4" /> Add Sensor Group
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Sensor groups batch polling so sensors on a level are not all queried at once.
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {sensorGroups.map((group, i) => (
                  <MotionDiv
                    key={group.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                  >
                    <Card className="group rounded-xl border-[#3a424b] bg-[#282e35] text-white shadow-[0_.125rem_.25rem_rgba(0,0,0,.3)] transition-all hover:border-[#495057]">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                              <Radio className="w-4 h-4 text-emerald-500" />
                            </div>
                            <div>
                              <p className="font-semibold text-sm">{group.groupId}</p>
                              <p className="text-xs text-muted-foreground">{group.sensorProtocol || 'NWAVE'}</p>
                            </div>
                          </div>
                          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => {
                              setSensorGroupForm({
                                groupId: group.groupId || '',
                                controllerAddress: group.controllerAddress || '',
                                controllerKey: group.controllerKey || '',
                                sensorProtocol: group.sensorProtocol || 'NWAVE',
                                parentLevel: group.parentLevel || '',
                              });
                              setEditSensorGroup(group);
                              setGroupSyncError('');
                              setShowSensorGroupModal(true);
                            }} className="p-1.5 rounded-md text-[#949494] hover:bg-[#1d242c] hover:text-white cursor-pointer">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleDeleteSensorGroup(group.id)} className="p-1.5 rounded-md hover:bg-[#ff5b57]/10 cursor-pointer">
                              <Trash2 className="w-3.5 h-3.5 text-[#ff5b57]" />
                            </button>
                          </div>
                        </div>
                        {group.controllerAddress && (
                          <div className="text-xs text-muted-foreground font-mono truncate">
                            {group.controllerAddress}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </MotionDiv>
                ))}
                {sensorGroups.length === 0 && (
                  <div className="col-span-full py-12 flex flex-col items-center gap-3 text-muted-foreground">
                    <Radio className="w-10 h-10 opacity-30" />
                    <p className="text-sm">No sensor groups configured</p>
                    <p className="text-xs">Add groups to stagger sensor polling</p>
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Level Modal */}
      <Dialog open={showLevelModal} onOpenChange={setShowLevelModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editLevel
                ? (levelForm.isZone ? 'Edit Zone' : 'Edit Level')
                : (levelForm.isZone ? 'Add Zone' : 'Add Level')}
            </DialogTitle>
            <DialogDescription>
              {levelForm.isZone
                ? 'Zones are GarageLevels rows (LevelType = FLI). Cameras stay on the parent floor; traffic can target the zone.'
                : (editLevel
                  ? 'Update level details and optionally quick-add devices.'
                  : 'Configure the new level and optionally quick-add devices.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <Label htmlFor="level-is-zone">This is a zone</Label>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Writes LevelType = FLI on the sheet. No cameras, signs, or sensors.
                </p>
              </div>
              <Switch
                id="level-is-zone"
                checked={!!levelForm.isZone}
                onCheckedChange={(checked) => {
                  setLevelForm((f) => {
                    if (!checked) {
                      return { ...f, isZone: false, parentLevelId: null };
                    }
                    const parent = floorLevelList.find((l) => l.id === f.parentLevelId) || floorLevelList[0];
                    const autoName = parent
                      ? nextZoneLevelName(parent, levels, editLevel?.id ?? null)
                      : 'Zone 1';
                    return {
                      ...f,
                      isZone: true,
                      parentLevelId: parent?.id ?? null,
                      name: (!editLevel || !f.name?.trim()) ? autoName : f.name,
                    };
                  });
                  setBulkCounts(makeEmptyBulkCounts());
                }}
              />
            </div>

            {levelForm.isZone && (
              <div>
                <Label>Parent level *</Label>
                <Select
                  value={levelForm.parentLevelId != null ? String(levelForm.parentLevelId) : 'none'}
                  onValueChange={(v) => {
                    if (v === 'none') {
                      setLevelForm((f) => ({ ...f, parentLevelId: null }));
                      return;
                    }
                    const parent = floorLevelList.find((l) => String(l.id) === v);
                    setLevelForm((f) => {
                      const keepCustom = editLevel && f.name?.trim();
                      const looksLikeAuto = /^Zone\s+\d+$/i.test(String(f.name || '').trim());
                      return {
                        ...f,
                        parentLevelId: parent ? parent.id : null,
                        name: (!keepCustom || looksLikeAuto) && parent
                          ? nextZoneLevelName(parent, levels, editLevel?.id ?? null)
                          : f.name,
                      };
                    });
                  }}
                >
                  <SelectTrigger className="mt-1.5">
                    <SelectValue placeholder="Select parent floor..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select parent floor...</SelectItem>
                    {floorLevelList.map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <Label>{levelForm.isZone ? 'Zone Name *' : 'Level Name *'}</Label>
              <Input
                value={levelForm.name}
                onChange={e => setLevelForm(f => ({ ...f, name: e.target.value }))}
                placeholder={levelForm.isZone ? 'Zone 1' : 'Level 1'}
                className="mt-1.5"
              />
              {levelForm.isZone && levelForm.parentLevelId != null && levelForm.name?.trim() && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Sheet Level:{' '}
                  <span className="text-foreground">
                    {zoneSheetLevelName({
                      ...levelForm,
                      isZone: true,
                      name: levelForm.name.trim(),
                      parentLevelId: levelForm.parentLevelId,
                    }, levels)}
                  </span>
                </p>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Total Spots</Label>
                <Input type="number" value={levelForm.totalSpots} onChange={e => setLevelForm(f => ({ ...f, totalSpots: e.target.value }))} className="mt-1.5" />
              </div>
              <div>
                <Label>EV Spots</Label>
                <Input type="number" value={levelForm.evSpots} onChange={e => setLevelForm(f => ({ ...f, evSpots: e.target.value }))} className="mt-1.5" />
              </div>
              <div>
                <Label>ADA Spots</Label>
                <Input type="number" value={levelForm.handicapSpots} onChange={e => setLevelForm(f => ({ ...f, handicapSpots: e.target.value }))} className="mt-1.5" />
              </div>
            </div>

            {/* Quick-add devices (collapsible per category) — not for zones */}
            {!levelForm.isZone && (
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
                Pre-create devices with auto IDs (F1, NW1, LED1…). They'll show up as Unplaced — drop them on the map and rename in the Inspector.
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
                          <motion.div
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
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </div>
            )}
          </div>
          {levelSyncError && (
            <p className="text-sm text-amber-700 dark:text-amber-300 px-6">{levelSyncError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLevelModal(false)} disabled={savingLevel}>Cancel</Button>
            <Button
              onClick={handleSaveLevel}
              disabled={
                !levelForm.name.trim()
                || savingLevel
                || (levelForm.isZone && levelForm.parentLevelId == null)
              }
            >
              {bulkSummary.total > 0
                ? `${editLevel ? 'Save' : 'Add Level'} & Add ${bulkSummary.total} Device${bulkSummary.total === 1 ? '' : 's'}`
                : (editLevel ? 'Save' : (levelForm.isZone ? 'Add Zone' : 'Add Level'))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Display Group Modal */}
      <Dialog open={showDisplayGroupModal} onOpenChange={setShowDisplayGroupModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editDisplayGroup ? 'Edit Display Group' : 'Add Display Group'}</DialogTitle>
            <DialogDescription>
              Groups stagger sign updates. Assign signs to a group in the device inspector.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Group Name *</Label>
              <Input
                value={displayGroupForm.name}
                onChange={(e) => setDisplayGroupForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Group1"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Force Send After (seconds)</Label>
              <Input
                type="number"
                min={1}
                value={displayGroupForm.forceSendAfterSeconds}
                onChange={(e) => setDisplayGroupForm((f) => ({
                  ...f,
                  forceSendAfterSeconds: Number(e.target.value) || DISPLAY_GROUP_DEFAULT_FORCE_SEND_SECONDS,
                }))}
                className="mt-1.5"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>Send Only On Updates</Label>
              <Switch
                checked={displayGroupForm.sendOnlyOnUpdates}
                onCheckedChange={(v) => setDisplayGroupForm((f) => ({ ...f, sendOnlyOnUpdates: v }))}
              />
            </div>
          </div>
          {groupSyncError && (
            <p className="text-sm text-destructive">{groupSyncError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDisplayGroupModal(false)}>Cancel</Button>
            <Button onClick={handleSaveDisplayGroup} disabled={!displayGroupForm.name.trim()}>
              {editDisplayGroup ? 'Save' : 'Add Group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sensor Group Modal */}
      <Dialog open={showSensorGroupModal} onOpenChange={setShowSensorGroupModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editSensorGroup ? 'Edit Sensor Group' : 'Add Sensor Group'}</DialogTitle>
            <DialogDescription>
              Groups stagger sensor polling. Assign sensors to a group in the device inspector.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Group ID *</Label>
              <Input
                value={sensorGroupForm.groupId}
                onChange={(e) => setSensorGroupForm((f) => ({ ...f, groupId: e.target.value }))}
                placeholder="Group1"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Sensor Protocol</Label>
              <Select
                value={sensorGroupForm.sensorProtocol}
                onValueChange={(v) => setSensorGroupForm((f) => ({ ...f, sensorProtocol: v }))}
              >
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SENSOR_PROTOCOL_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Controller Address</Label>
              <Input
                value={sensorGroupForm.controllerAddress}
                onChange={(e) => setSensorGroupForm((f) => ({ ...f, controllerAddress: e.target.value }))}
                placeholder="http://..."
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Controller Key</Label>
              <Input
                value={sensorGroupForm.controllerKey}
                onChange={(e) => setSensorGroupForm((f) => ({ ...f, controllerKey: e.target.value }))}
                placeholder="API key"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Parent Level</Label>
              <Select
                value={sensorGroupForm.parentLevel || 'none'}
                onValueChange={(v) => setSensorGroupForm((f) => ({ ...f, parentLevel: v === 'none' ? '' : v }))}
              >
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="Optional" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {floorLevelList.map((l) => (
                    <SelectItem key={l.id} value={l.name}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {groupSyncError && (
            <p className="text-sm text-destructive">{groupSyncError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSensorGroupModal(false)}>Cancel</Button>
            <Button onClick={handleSaveSensorGroup} disabled={!sensorGroupForm.groupId.trim()}>
              {editSensorGroup ? 'Save' : 'Add Group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Server Modal */}
      <Dialog open={showServerModal} onOpenChange={(open) => {
        setShowServerModal(open);
        if (!open) setServerSyncError('');
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editServer ? 'Edit Server' : 'Add Server'}</DialogTitle>
            <DialogDescription>Configure server identity, network, and remote-access details.</DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="identity">
            <TabsList className="w-full">
              <TabsTrigger value="identity" className="flex-1">Identity</TabsTrigger>
              <TabsTrigger value="network" className="flex-1">Network</TabsTrigger>
              <TabsTrigger value="splashtop" className="flex-1">Splashtop</TabsTrigger>
            </TabsList>

            <TabsContent value="identity" className="space-y-3 mt-3">
              <div>
                <Label>Server Name *</Label>
                <Input value={serverForm.name} onChange={e => setServerForm(f => ({ ...f, name: e.target.value }))} placeholder="Server-01" className="mt-1.5" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Model</Label>
                  <Select value={serverForm.model || ''} onValueChange={v => setServerForm(f => ({ ...f, model: v }))}>
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select model..." /></SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Operating System</Label>
                  <Select value={serverForm.os} onValueChange={v => setServerForm(f => ({ ...f, os: v }))}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {OS_OPTIONS.map(os => <SelectItem key={os} value={os}>{os}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="network" className="space-y-3 mt-3">
              <div className="flex items-center gap-3">
                <Label>Number of ports:</Label>
                <Select
                  value={String(serverForm.ports?.length || 1)}
                  onValueChange={v => {
                    const count = Number(v);
                    const current = serverForm.ports || [];
                    let newPorts;
                    if (count > current.length) {
                      newPorts = [...current, ...Array.from({ length: count - current.length }, () => ({ ...DEFAULT_PORT }))];
                    } else {
                      newPorts = current.slice(0, count);
                    }
                    setServerForm(f => ({ ...f, ports: newPorts }));
                  }}
                >
                  <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-3">
                {(serverForm.ports || []).map((port, idx) => (
                  <div key={idx} className="rounded-lg border border-primary/30 p-3 space-y-2">
                    <p className="text-xs font-semibold text-primary">Port {idx + 1}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-[11px]">MAC</Label>
                        <Input
                          value={port.mac}
                          onChange={e => {
                            const newPorts = [...serverForm.ports];
                            newPorts[idx] = { ...newPorts[idx], mac: e.target.value };
                            setServerForm(f => ({ ...f, ports: newPorts }));
                          }}
                          placeholder="00:1A:2B:3C:4D:5E"
                          className="mt-1 font-mono text-xs"
                        />
                      </div>
                      <div>
                        <Label className="text-[11px]">IP</Label>
                        <Input
                          value={port.ip}
                          onChange={e => {
                            const newPorts = [...serverForm.ports];
                            newPorts[idx] = { ...newPorts[idx], ip: e.target.value };
                            setServerForm(f => ({ ...f, ports: newPorts }));
                          }}
                          placeholder="10.16.6.100"
                          disabled={port.dhcp}
                          className="mt-1 font-mono text-xs"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          const newPorts = [...serverForm.ports];
                          newPorts[idx] = { ...newPorts[idx], dhcp: false };
                          setServerForm(f => ({ ...f, ports: newPorts }));
                        }}
                        className={`px-3 py-1 rounded text-[11px] font-medium cursor-pointer transition-all ${
                          !port.dhcp ? 'bg-primary/20 text-primary border border-primary/40' : 'bg-muted text-muted-foreground border border-transparent'
                        }`}
                      >
                        Static
                      </button>
                      <button
                        onClick={() => {
                          const newPorts = [...serverForm.ports];
                          newPorts[idx] = { ...newPorts[idx], dhcp: true };
                          setServerForm(f => ({ ...f, ports: newPorts }));
                        }}
                        className={`px-3 py-1 rounded text-[11px] font-medium cursor-pointer transition-all ${
                          port.dhcp ? 'bg-primary/20 text-primary border border-primary/40' : 'bg-muted text-muted-foreground border border-transparent'
                        }`}
                      >
                        DHCP
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="splashtop" className="space-y-3 mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Username</Label>
                  <Input value={serverForm.splashtopUser || ''} onChange={e => setServerForm(f => ({ ...f, splashtopUser: e.target.value }))} placeholder="Administrator" className="mt-1.5" />
                </div>
                <div>
                  <Label>Password</Label>
                  <div className="relative mt-1.5">
                    <Input
                      type={showSplashtopPw ? 'text' : 'password'}
                      value={serverForm.splashtopPassword}
                      onChange={e => setServerForm(f => ({ ...f, splashtopPassword: e.target.value }))}
                      placeholder="password"
                      className="pr-8"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSplashtopPw(!showSplashtopPw)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      {showSplashtopPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <Label>Shortcut URL</Label>
                <Input
                  value={serverForm.splashtopUrl || ''}
                  onChange={e => setServerForm(f => ({ ...f, splashtopUrl: e.target.value }))}
                  placeholder="st-business://com.splashtop.business/?shortcut=..."
                  className="mt-1.5 font-mono text-xs"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Paste the st-business:// shortcut URL</p>
              </div>
            </TabsContent>
          </Tabs>
          <DialogFooter>
            {serverSyncError && (
              <p className="w-full text-sm text-destructive text-left mr-auto">{serverSyncError}</p>
            )}
            <Button variant="outline" onClick={() => setShowServerModal(false)} disabled={savingServer}>Cancel</Button>
            <Button onClick={handleSaveServer} disabled={!serverForm.name.trim() || savingServer}>
              {editServer ? 'Save' : 'Add Server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
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
                  setViewSyncError(err.message || 'Delete failed. Try again.');
                  setConfirmDelete(null);
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
