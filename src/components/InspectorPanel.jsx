import React, { useState, useCallback } from 'react';
import { motion } from 'motion/react';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Switch } from './ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { ScrollArea } from './ui/scroll-area';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { Textarea } from './ui/textarea';
import {
  generateCameraHubConfig,
  generateDevicesConfig,
  generateFLICameraConfig,
  downloadFile as downloadConfigFile,
} from '../services/ConfigService';
import {
  X, Trash2, Download,
  ArrowUp, ArrowDown, Copy, Plus,
} from 'lucide-react';
import { DeviceIcon as DeviceIconSvg } from './DeviceIcons';
import {
  normalizeTrafficDirection,
  invertTrafficDirection,
  flowDestinationOptions,
  flowTargetLabel,
  flowTargetOptions,
  levelsHaveZones,
  normalizeFlowDestinations,
  parseFlowTargetKey,
  resolveFlowTargetKey,
} from '../lib/trafficFlowUtils';
import GroupAssignmentSelect from './GroupAssignmentSelect';
import DisplayLevelSelect from './DisplayLevelSelect';
import { DISPLAY_PROTOCOL_OPTIONS } from '../lib/configSheetSchema';
import {
  cameraTypeShortLabel,
  defaultSecondStreamType,
  normalizeCameraHardwareType,
  isDualLensCamera,
  streamSyncSheetName,
} from '../lib/deviceNamingUtils';
import {
  createSignInsert,
  insertLevelSummary,
  signUsesInserts,
  withEthernetOnInsert,
} from '../lib/signInserts';
import { InspectorSection } from './ui/inspector-section';
import { isZoneLevel } from '../lib/zoneLevelUtils';
import PhotoPickControls from './PhotoPickControls';
import {
  MAX_SIGN_PHOTOS,
  prepareDevicePhotoFromFile,
  prepareDevicePhotosFromFiles,
} from '../lib/photoPick';

export default function InspectorPanel({
  device, onUpdateDevice, onCommitDeviceToSheet, onCopyDevice, onRemoveDevice, onDeleteDevice,
  onPlaceDevice,
  servers = [], displayGroups = [], sensorGroups = [], mdfIdfLocations = [],
  garages = [],
  onAddDisplayGroup, onAddSensorGroup, onAddMdfIdfLocation,
  levels = [], currentLevel = null, deviceTypes, canSyncToSheet = false, onClose,
  onToast,
}) {
  const [activeTab, setActiveTab] = useState('general');
  const [exportError, setExportError] = useState(null);
  const sheetSync = canSyncToSheet;

  const update = useCallback((field, value, { syncToSheet = false } = {}) => {
    onUpdateDevice(device.id, { [field]: value }, { syncToSheet: sheetSync && syncToSheet });
  }, [device?.id, onUpdateDevice, sheetSync]);

  const updateFields = useCallback((updates, { syncToSheet = false } = {}) => {
    onUpdateDevice(device.id, updates, { syncToSheet: sheetSync && syncToSheet });
  }, [device?.id, onUpdateDevice, sheetSync]);

  const commitToSheet = useCallback(() => {
    if (sheetSync) onCommitDeviceToSheet?.(device.id);
  }, [device?.id, onCommitDeviceToSheet, sheetSync]);

  const updateSignDisplayName = useCallback((value) => {
    const prev = device.friendlyName || '';
    const updates = { friendlyName: value };
    const ctrl = device.controllerName ?? '';
    const vis = device.visibleName ?? '';
    if (!ctrl || ctrl === prev) updates.controllerName = value;
    if (!vis || vis === prev) updates.visibleName = value;
    onUpdateDevice(device.id, updates, { syncToSheet: false });
  }, [device, onUpdateDevice]);

  const commitSignDisplayName = useCallback(() => {
    if (!sheetSync) return;
    onCommitDeviceToSheet?.(device.id);
  }, [device?.id, onCommitDeviceToSheet, sheetSync]);

  const updateStream = useCallback((streamKey, field, value, { syncToSheet = false } = {}) => {
    const raw = device[streamKey];
    // Normalize: if stream is a flat string (imported RTSP URL), convert to object
    const stream = (typeof raw === 'object' && raw !== null) ? raw : {
      ipAddress: device.ipAddress || '',
      port: device.port || '554',
      externalUrl: typeof raw === 'string' ? raw : '',
      streamType: device.type,
    };
    const updates = { [streamKey]: { ...stream, [field]: value } };
    if (streamKey === 'stream1') {
      if (field === 'ipAddress') updates.ipAddress = value;
      if (field === 'port') updates.port = value;
      if (field === 'externalUrl') updates.rtspUrl = value;
    }
    onUpdateDevice(device.id, updates, { syncToSheet: sheetSync && syncToSheet });
  }, [device, onUpdateDevice, sheetSync]);

  const updateTrafficFlow = useCallback((field, value, { syncToSheet = false } = {}) => {
    const flow = device.trafficFlow || {};
    onUpdateDevice(device.id, { trafficFlow: { ...flow, [field]: value } }, { syncToSheet: sheetSync && syncToSheet });
  }, [device, onUpdateDevice, sheetSync]);

  const updateTrafficFlowFields = useCallback((updates, { syncToSheet = false } = {}) => {
    const flow = device.trafficFlow || {};
    onUpdateDevice(device.id, { trafficFlow: { ...flow, ...updates } }, { syncToSheet: sheetSync && syncToSheet });
  }, [device, onUpdateDevice, sheetSync]);

  const handleExportConfig = useCallback(() => {
    if (!device) return;
    setExportError(null);
    try {
      if (device.type?.startsWith('cam-')) {
        const xml = generateCameraHubConfig([device]);
        downloadConfigFile(xml, `${device.name}-camerahub.xml`);
        if (device.type === 'cam-fli') {
          const fliXml = generateFLICameraConfig(device);
          downloadConfigFile(fliXml, `${device.name}-fli.xml`);
        }
      }
      const devXml = generateDevicesConfig([device]);
      downloadConfigFile(devXml, `${device.name}-devices.xml`);
    } catch (e) {
      console.error('Config export failed:', e);
      const message = e?.message ? `Export failed: ${e.message}` : 'Config export failed';
      setExportError(message);
      onToast?.(message);
    }
  }, [device, onToast]);

  if (!device) return null;

  const isCamera = device.type?.startsWith('cam-');
  const isSign = device.type?.startsWith('sign-');
  const isSensor = device.type?.startsWith('sensor-');
  const isDualLens = isDualLensCamera(device);

  const deviceColor = {
    'cam-fli': 'text-blue-500',
    'cam-lpr': 'text-violet-500',
    'cam-people': 'text-cyan-500',
    'sign-led': 'text-amber-500',
    'sign-static': 'text-yellow-500',
    'sign-designable': 'text-orange-500',
    'sensor-nwave': 'text-emerald-500',
    'sensor-parksol': 'text-teal-500',
    'sensor-proco': 'text-green-500',
    'sensor-ensight': 'text-green-400',
  }[device.type] || 'text-primary';

  // Helper: get safe IP/port/RTSP from structured camera stream data
  const getDeviceIp = () => {
    if (isCamera) {
      const s = device.stream1;
      if (typeof s === 'object' && s !== null) return s.ipAddress ?? '';
      return device.ipAddress || '';
    }
    return device.ipAddress || '';
  };
  const getDevicePort = () => {
    if (isCamera) {
      const s = device.stream1;
      if (typeof s === 'object' && s !== null) return s.port ?? '';
      return device.port || '';
    }
    return device.port || '';
  };
  const getDeviceRtsp = () => {
    const s = device.stream1;
    if (typeof s === 'string') return s;
    if (typeof s === 'object' && s !== null) return s.externalUrl || device.rtspUrl || '';
    return device.rtspUrl || '';
  };
  const getStreamField = (streamKey, field) => {
    const s = device[streamKey];
    if (typeof s === 'object' && s !== null) return s[field] ?? '';
    // Legacy flat fields only describe stream 1 — never show them on stream 2.
    if (streamKey !== 'stream1') return '';
    if (field === 'ipAddress') return device.ipAddress || '';
    if (field === 'port') return device.port || '';
    if (field === 'externalUrl') return (typeof s === 'string' ? s : '') || device.rtspUrl || '';
    return '';
  };

  const trafficDirection = normalizeTrafficDirection(device.trafficFlow?.direction);
  // Back-compat: cameras configured before the flag existed are treated as
  // multi-level if they already have destinations.
  const isMultiLevelCamera = Boolean(
    device.trafficFlow?.multiLevel ?? (device.trafficFlow?.destinations?.length > 0),
  );
  // Level the primary flow applies to — defaults to the camera's own level
  const primaryLevelValue = device.trafficFlow?.level || currentLevel?.id?.toString() || '';
  // Flow can target a whole level or one zone on it; a zone that was deleted
  // resolves back to its level rather than leaving the control blank.
  const primaryTargetKey = resolveFlowTargetKey(levels, primaryLevelValue, device.trafficFlow?.zone);
  const primaryTargetName = flowTargetLabel(
    levels,
    primaryLevelValue,
    device.trafficFlow?.zone,
    currentLevel?.name || 'this level',
  );
  const targetOptions = flowTargetOptions(levels);
  const hasZones = levelsHaveZones(levels);
  const showFlowTarget = levels.length > 1 || hasZones;
  const targetNoun = hasZones ? 'level or zone' : 'level';
  const destinationKeys = normalizeFlowDestinations(device.trafficFlow?.destinations);
  const destinationOptions = flowDestinationOptions(levels, primaryTargetKey);

  const hwLabel = isCamera
    ? (deviceTypes?.hardwareTypes?.find((h) => h.id === normalizeCameraHardwareType(device.hardwareType))?.name
      || normalizeCameraHardwareType(device.hardwareType)
      || 'Bullet')
    : '';
  const camTypeLabel = isCamera
    ? (isDualLens
      ? `${cameraTypeShortLabel(device.stream1?.streamType || device.type)}/${cameraTypeShortLabel(device.stream2?.streamType || device.type)}`
      : (deviceTypes?.cameras?.find((c) => c.id === device.type)?.name || cameraTypeShortLabel(device.type)))
    : '';
  const typeHardwareSummary = isCamera
    ? `${hwLabel} · ${camTypeLabel}`
    : isSign
      ? (device.displayProtocol || '—')
      : isSensor
        ? (deviceTypes?.sensorGroups?.find((s) => s.id === (device.sensorGroup || device.type))?.name
          || device.sensorGroup || device.type || '—')
        : '—';

  const displayGroupResolved = device.displayGroupId != null
    ? displayGroups.find((g) => g.id === device.displayGroupId)
    : (device.displayGroupName
      ? displayGroups.find((g) => g.name === device.displayGroupName)
      : null);
  const displayGarage = garages.find((g) => g.id === device.displayGarageId);
  const displayConfigSummary = [
    displayGroupResolved?.name || device.displayGroupName || '',
    displayGarage?.name || displayGarage?.internalName || '',
  ].filter(Boolean).join(' · ') || '—';

  const serverName = device.serverId != null
    ? (servers.find((s) => s.id === device.serverId)?.name || 'Server')
    : (device.server || 'No server');
  const mdfName = mdfIdfLocations.find((l) => l.id === device.mdfIdfLocationId)?.name || '';
  const assignmentsSummary = [serverName, mdfName].filter(Boolean).join(' · ');

  const boldSidesSummary = Array.isArray(device.boldSides)
    ? device.boldSides
    : ((device.sided || 'single') === 'dual' ? [] : ['top']);
  const facingSummary = `${(device.sided || 'single') === 'dual' ? 'Dual' : 'Single'} · ${Math.round(device.rotation || 0)}° · display: ${boldSidesSummary.join(',') || '—'}`;

  const fovRot = device.stream1?.rotation ?? 0;
  const fovCone = device.coneSize ?? device.stream1?.coneSize ?? 40;
  const fovColor = device.color || device.stream1?.color || '#348fe2';
  const insertCount = Array.isArray(device.inserts) ? device.inserts.length : 0;

  const addInsert = () => {
    const existing = Array.isArray(device.inserts) ? device.inserts : null;
    const defaultLevelIds = Array.isArray(device.displayLevelIds)
      ? device.displayLevelIds.slice(0, 1)
      : (currentLevel ? [currentLevel.id] : []);
    if (!existing) {
      updateFields({
        inserts: [createSignInsert({
          displayName: device.friendlyName || '',
          serialAddress: device.serialAddress || '',
          hasEthernet: true,
          displayLevelAll: !!device.displayLevelAll,
          displayLevelIds: defaultLevelIds,
        })],
      }, { syncToSheet: true });
      return;
    }
    updateFields({
      inserts: [
        ...existing,
        createSignInsert({
          hasEthernet: existing.length === 0,
          displayLevelIds: defaultLevelIds,
        }),
      ],
    }, { syncToSheet: true });
  };

  const statusBadge = device.pendingPlacement ? (
    <Badge variant="outline" className="text-[9px] py-0 px-1.5 border-warning/40 text-warning">Unplaced</Badge>
  ) : device.disabled ? (
    <Badge variant="outline" className="text-[9px] py-0 px-1.5 border-destructive/40 text-destructive">Disabled</Badge>
  ) : (
    <Badge variant="outline" className="text-[9px] py-0 px-1.5 border-emerald-500/40 text-emerald-500">Active</Badge>
  );

  return (
    <motion.div
      initial={{ x: 50, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      className="w-[380px] border-l border-[#3a424b] bg-[#151c23] text-white flex flex-col shrink-0 h-full min-h-0 overflow-hidden shadow-[-12px_0_30px_rgba(0,0,0,0.12)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#3a424b] gap-2 bg-[#192129]">
        <div className="flex items-center gap-2 min-w-0">
          <DeviceIconSvg type={device.type} className={`w-4 h-4 shrink-0 ${deviceColor}`} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="text-sm font-semibold truncate">
                {isDualLens
                  ? `${streamSyncSheetName(device, 1)} / ${streamSyncSheetName(device, 2)}`
                  : device.name}
              </div>
              {statusBadge}
            </div>
            {device.friendlyName && (
              <div className="text-[10px] text-muted-foreground truncate">{device.friendlyName}</div>
            )}
            {isDualLens && !device.friendlyName && (
              <div className="text-[10px] text-muted-foreground truncate">Dual lens</div>
            )}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <Button variant="ghost" size="icon-sm" onClick={handleExportConfig} title="Export Config" className="hover:bg-white/10">
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close" className="hover:bg-white/10">
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Tab Navigation */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-3 mt-3 h-8 bg-[#202932] border border-[#3a424b] p-0.5">
          <TabsTrigger value="general" className="text-xs flex-1">General</TabsTrigger>
          {(isCamera || isSign) && <TabsTrigger value="network" className="text-xs flex-1">Network</TabsTrigger>}
          {isCamera && <TabsTrigger value="media" className="text-xs flex-1">Media</TabsTrigger>}
          {isSign && <TabsTrigger value="photos" className="text-xs flex-1">Photos</TabsTrigger>}
          {isCamera && <TabsTrigger value="traffic" className="text-xs flex-1">Traffic</TabsTrigger>}
        </TabsList>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-4 py-3">
            {/* General Tab */}
            <TabsContent value="general" className="mt-0 flex flex-col gap-1.5">
              <InspectorSection
                id="general-identity"
                title="Identity & Status"
                defaultOpen
                summary={device.friendlyName || '—'}
              >
                <div className="grid grid-cols-2 gap-2">
                  <div className="min-w-0">
                    <Label>Device Name</Label>
                    <Input value={device.name || ''} readOnly disabled className="mt-1.5" />
                    <p className="text-[10px] text-muted-foreground mt-1">Auto-assigned sequential ID — not editable.</p>
                  </div>
                  {(isCamera || isSign || isSensor) && (
                    <div className="min-w-0">
                      <Label>{isSign ? 'Display Name' : 'Friendly Name'}</Label>
                      <Input
                        value={device.friendlyName || ''}
                        onChange={e => isSign
                          ? updateSignDisplayName(e.target.value)
                          : update('friendlyName', e.target.value)}
                        onBlur={isSign ? commitSignDisplayName : isCamera ? commitToSheet : undefined}
                        placeholder={isCamera ? 'e.g. North Entry FLI' : isSign ? 'e.g. Level 1 Entry Sign' : 'e.g. Row A Sensors'}
                        className="mt-1.5"
                      />
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {isSign
                          ? (signUsesInserts(device) && (device.inserts?.length || 0) > 0
                            ? 'Reference label for this monument. Sheet DisplayName comes from each insert below.'
                            : (sheetSync
                              ? 'Saved to DisplayControllers tab as DisplayName when no inserts are defined.'
                              : 'Display name for this sign.'))
                          : isSensor
                            ? 'Reference label — stored locally / in SetupJson only (not a sheet field).'
                            : (sheetSync
                              ? 'Reference label — saved to Google Sheet when you leave this field.'
                              : 'Reference label for this device.')}
                      </p>
                    </div>
                  )}
                  {isSign && (
                    <>
                      <div className="min-w-0">
                        <Label>Display Controller Name</Label>
                        <Input
                          value={device.controllerName || device.friendlyName || ''}
                          onChange={e => update('controllerName', e.target.value, { syncToSheet: true })}
                          placeholder="Same as display name by default"
                          className="mt-1.5"
                        />
                        {!sheetSync && (
                          <p className="text-[10px] text-muted-foreground mt-1">Stored with this sign configuration.</p>
                        )}
                      </div>
                      <div className="min-w-0">
                        <Label>Visible Display Name</Label>
                        <Input
                          value={device.visibleName || device.friendlyName || ''}
                          onChange={e => update('visibleName', e.target.value, { syncToSheet: true })}
                          placeholder="Same as display name by default"
                          className="mt-1.5"
                        />
                        {!sheetSync && (
                          <p className="text-[10px] text-muted-foreground mt-1">Stored with this sign configuration.</p>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="disabled-toggle" className="text-xs">Disabled</Label>
                  <Switch
                    id="disabled-toggle"
                    checked={!!device.disabled}
                    onCheckedChange={(v) => update('disabled', v, { syncToSheet: true })}
                  />
                </div>

                {device.pendingPlacement && (
                  <div className="space-y-2">
                    {onPlaceDevice && (
                      <Button
                        type="button"
                        size="sm"
                        className="w-full"
                        onClick={() => onPlaceDevice(device.id)}
                      >
                        Place on map
                      </Button>
                    )}
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Reason not placed</Label>
                      <Textarea
                        value={device.placementReason || ''}
                        onChange={e => update('placementReason', e.target.value)}
                        placeholder="Why hasn't this been placed on the map yet?"
                        rows={2}
                        className="mt-1 text-xs"
                      />
                    </div>
                  </div>
                )}

                {device.disabled && (
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Reason for disabling</Label>
                    <Textarea
                      value={device.disabledReason || ''}
                      onChange={e => update('disabledReason', e.target.value)}
                      placeholder="Why is this device disabled?"
                      rows={2}
                      className="mt-1 text-xs"
                    />
                  </div>
                )}
              </InspectorSection>

              {(isCamera || isSign || isSensor) && (
                <InspectorSection
                  id="general-type-hardware"
                  title="Type & Hardware"
                  defaultOpen
                  summary={typeHardwareSummary}
                >
                  {isCamera && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="min-w-0">
                        <Label>Hardware Type</Label>
                        <Select
                          value={normalizeCameraHardwareType(device.hardwareType) || 'bullet'}
                          onValueChange={(v) => {
                            if (v === 'dual-lens') {
                              const hasStream2 = typeof device.stream2 === 'object' && device.stream2 !== null;
                              if (!hasStream2) {
                                const stream1Type = device.stream1?.streamType || device.type;
                                updateFields({
                                  hardwareType: 'dual-lens',
                                  stream1: {
                                    ...(typeof device.stream1 === 'object' && device.stream1 ? device.stream1 : {}),
                                    streamType: stream1Type,
                                  },
                                  stream2: {
                                    ipAddress: '',
                                    port: '554',
                                    externalUrl: '',
                                    streamType: defaultSecondStreamType(stream1Type),
                                  },
                                }, { syncToSheet: true });
                              } else {
                                update('hardwareType', 'dual-lens', { syncToSheet: true });
                              }
                            } else if (v === 'bullet') {
                              update('hardwareType', 'bullet', { syncToSheet: true });
                            }
                          }}
                        >
                          <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {deviceTypes.hardwareTypes.map(hw => (
                              <SelectItem key={hw.id} value={hw.id}>{hw.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {isDualLens && (
                          <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                            Dual lens keeps the imported ID on Stream 1 and adds Stream 2
                            (usually LPR). Set each stream&apos;s type below.
                          </p>
                        )}
                      </div>
                      {!isDualLens && (
                        <div className="min-w-0">
                          <Label>Camera Type</Label>
                          <Select value={device.type} onValueChange={v => update('type', v, { syncToSheet: true })}>
                            <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {deviceTypes.cameras.map(c => (
                                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  )}

                  {isCamera && isDualLens && (
                    <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 space-y-1">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Streams</p>
                      <p className="text-xs text-foreground">
                        <span className="font-medium">{streamSyncSheetName(device, 1)}</span>
                        <span className="text-muted-foreground"> · {cameraTypeShortLabel(device.stream1?.streamType || device.type)}</span>
                        <span className="text-muted-foreground"> · Stream 1</span>
                      </p>
                      <p className="text-xs text-foreground">
                        <span className="font-medium">{streamSyncSheetName(device, 2)}</span>
                        <span className="text-muted-foreground"> · {cameraTypeShortLabel(device.stream2?.streamType || device.type)}</span>
                        <span className="text-muted-foreground"> · Stream 2</span>
                      </p>
                    </div>
                  )}

                  {isSign && (
                    <div>
                      <Label>Display Protocol</Label>
                      <Select
                        value={device.displayProtocol || 'none'}
                        onValueChange={v => update('displayProtocol', v === 'none' ? '' : v, { syncToSheet: true })}
                      >
                        <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select protocol..." /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Not set</SelectItem>
                          {device.displayProtocol
                            && !DISPLAY_PROTOCOL_OPTIONS.includes(device.displayProtocol) && (
                            <SelectItem value={device.displayProtocol}>
                              {device.displayProtocol} (legacy)
                            </SelectItem>
                          )}
                          {DISPLAY_PROTOCOL_OPTIONS.map((protocol) => (
                            <SelectItem key={protocol} value={protocol}>{protocol}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Uses DisplayControllers protocol values. Leave unset rather than inventing LED/STATIC.
                      </p>
                    </div>
                  )}

                  {isSensor && (
                    <>
                      <div>
                        <Label>Sensor Protocol</Label>
                        <Select
                          value={device.sensorGroup || device.type}
                          onValueChange={v => updateFields({ sensorGroup: v, type: v })}
                        >
                          <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {deviceTypes.sensorGroups.map(sg => (
                              <SelectItem key={sg.id} value={sg.id}>{sg.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <GroupAssignmentSelect
                        label="Sensor Group Assignment"
                        description="Batches sensor polling so not every sensor is queried at once."
                        value={device.configSensorGroupId}
                        groups={sensorGroups}
                        getGroupLabel={(g) => g.groupId}
                        onChange={(id) => update('configSensorGroupId', id, { syncToSheet: true })}
                        onAddGroup={onAddSensorGroup}
                        noneLabel="No group"
                        addDialogTitle="Add Sensor Group"
                        addNameLabel="Group ID"
                        addPlaceholder="e.g. Group1"
                      />
                      <div>
                        <Label>Sensor Count</Label>
                        <Input type="number" value={device.sensorCount || 1} onChange={e => update('sensorCount', Number(e.target.value))} className="mt-1.5" />
                      </div>
                      {((device.sensorGroup || device.type) === 'sensor-nwave') && (
                        <div>
                          <Label>API Key</Label>
                          <Input value={device.apiKey || ''} onChange={e => update('apiKey', e.target.value)} placeholder="NWAVE API Key" className="mt-1.5" />
                        </div>
                      )}
                    </>
                  )}
                </InspectorSection>
              )}

              {isSign && (
                <InspectorSection
                  id="general-inserts"
                  title={insertCount > 0 ? `Inserts · ${insertCount}` : 'Inserts'}
                  defaultOpen
                  summary={insertCount > 0 ? `${insertCount} insert${insertCount === 1 ? '' : 's'}` : 'None'}
                  actions={(
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px] shrink-0"
                      onClick={addInsert}
                    >
                      <Plus className="h-3 w-3 mr-0.5" />
                      Add
                    </Button>
                  )}
                >
                  <p className="text-[10px] text-muted-foreground leading-snug">
                    One enclosure, shared IP. Flag ETH on the wired insert. Blank name uses map ID.
                  </p>

                  {signUsesInserts(device) && insertCount === 0 && (
                    <p className="text-[10px] text-muted-foreground rounded-md border border-dashed border-border px-2 py-1.5">
                      No inserts yet — add insert 1, 2, 3…
                    </p>
                  )}

                  {insertCount > 0 && (
                    <div className="rounded-md border border-border/70 divide-y divide-border/60">
                      {(device.inserts || []).map((insert, idx) => {
                        const garage = garages.find((g) => g.id === device.displayGarageId);
                        const garageLevels = garage?.levels || [];
                        const selectedIds = Array.isArray(insert.displayLevelIds) ? insert.displayLevelIds : [];
                        const levelSummary = insertLevelSummary(device, insert, garages);
                        const patchInsert = (patch, sync = false) => {
                          const next = (device.inserts || []).map((ins) => (
                            ins.id === insert.id ? { ...ins, ...patch } : ins
                          ));
                          updateFields({ inserts: next }, { syncToSheet: sync });
                        };
                        const toggleLevelId = (levelId) => {
                          const ids = selectedIds.includes(levelId)
                            ? selectedIds.filter((id) => id !== levelId)
                            : [...selectedIds, levelId];
                          patchInsert({ displayLevelAll: false, displayLevelIds: ids }, true);
                        };
                        const levelBtnClass = (active) => (
                          `w-full text-left px-2 py-1 rounded text-[10px] border transition-colors ${
                            active
                              ? 'bg-primary/10 text-primary border-primary/20'
                              : 'bg-muted/40 text-muted-foreground border-transparent hover:bg-accent'
                          }`
                        );
                        return (
                          <div key={insert.id} className="p-1.5 space-y-1.5">
                            <div className="grid grid-cols-[1.25rem_minmax(0,1.5fr)_2.75rem_1.75rem_1.25rem] gap-1 items-center">
                              <span className="text-[10px] text-muted-foreground tabular-nums">{idx + 1}</span>
                              <Input
                                value={insert.displayName || ''}
                                onChange={(e) => patchInsert({ displayName: e.target.value })}
                                onBlur={commitToSheet}
                                placeholder={device.name || 'Name'}
                                className="h-7 text-[11px] px-1.5"
                              />
                              <Input
                                value={insert.serialAddress || ''}
                                onChange={(e) => patchInsert({ serialAddress: e.target.value })}
                                onBlur={commitToSheet}
                                placeholder="#"
                                className="h-7 text-[11px] px-1"
                                title="Serial address"
                              />
                              <button
                                type="button"
                                title={insert.hasEthernet ? 'Ethernet insert' : 'Set as ethernet insert'}
                                aria-pressed={!!insert.hasEthernet}
                                onClick={() => {
                                  if (insert.hasEthernet) return;
                                  updateFields({
                                    inserts: withEthernetOnInsert(device.inserts || [], insert.id),
                                  }, { syncToSheet: true });
                                }}
                                className={`h-7 rounded text-[9px] font-semibold border transition-colors ${
                                  insert.hasEthernet
                                    ? 'bg-primary/15 border-primary/40 text-primary'
                                    : 'border-border text-muted-foreground hover:bg-muted'
                                }`}
                              >
                                ETH
                              </button>
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-destructive justify-self-center"
                                title="Remove insert"
                                onClick={() => {
                                  const next = (device.inserts || []).filter((ins) => ins.id !== insert.id);
                                  if (next.length && !next.some((ins) => ins.hasEthernet)) {
                                    next[0] = { ...next[0], hasEthernet: true };
                                  }
                                  updateFields({ inserts: next }, { syncToSheet: true });
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>

                            <div className="pl-5 space-y-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[9px] uppercase tracking-wide text-muted-foreground font-semibold">
                                  Levels / Zones
                                </span>
                                <span className="text-[10px] text-muted-foreground truncate" title={levelSummary}>
                                  {levelSummary}
                                </span>
                              </div>
                              {device.displayGarageId == null ? (
                                <p className="text-[10px] text-amber-600">
                                  Select a garage in Display Config first.
                                </p>
                              ) : (
                                <div className="space-y-0.5 max-h-40 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-1">
                                  <button
                                    type="button"
                                    aria-pressed={!!insert.displayLevelAll}
                                    onClick={() => patchInsert({
                                      displayLevelAll: !insert.displayLevelAll,
                                      displayLevelIds: !insert.displayLevelAll ? [] : selectedIds,
                                    }, true)}
                                    className={levelBtnClass(!!insert.displayLevelAll)}
                                  >
                                    All
                                  </button>
                                  {!insert.displayLevelAll && garageLevels.map((level) => {
                                    const selected = selectedIds.includes(level.id);
                                    const zone = isZoneLevel(level);
                                    return (
                                      <button
                                        key={level.id}
                                        type="button"
                                        aria-pressed={selected}
                                        onClick={() => toggleLevelId(level.id)}
                                        className={levelBtnClass(selected)}
                                      >
                                        {level.name || level.internalName}
                                        {zone ? (
                                          <span className="float-right text-[9px] opacity-70">zone</span>
                                        ) : null}
                                      </button>
                                    );
                                  })}
                                  {!insert.displayLevelAll && garageLevels.length === 0 && (
                                    <p className="px-2 py-1 text-[10px] text-muted-foreground">No levels in this garage.</p>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </InspectorSection>
              )}

              {isSign && (
                <InspectorSection
                  id="general-display-config"
                  title="Display Config"
                  defaultOpen={false}
                  summary={displayConfigSummary}
                >
                  <GroupAssignmentSelect
                    label="Display Group Assignment"
                    description="Batches sign updates so controllers are not all polled every cycle."
                    value={device.displayGroupId ?? (
                      device.displayGroupName
                        ? displayGroups.find((g) => g.name === device.displayGroupName)?.id
                        : null
                    )}
                    groups={displayGroups}
                    getGroupLabel={(g) => g.name}
                    onChange={(id) => update('displayGroupId', id, { syncToSheet: true })}
                    onAddGroup={onAddDisplayGroup}
                    noneLabel="No group"
                    addDialogTitle="Add Display Group"
                    addNameLabel="Group name"
                    addPlaceholder="e.g. Group1"
                  />
                  <DisplayLevelSelect
                    garages={garages}
                    garageId={device.displayGarageId ?? null}
                    levelAll={!!device.displayLevelAll}
                    levelIds={device.displayLevelIds || []}
                    onGarageChange={(id) => updateFields({
                      displayGarageId: id,
                      displayLevelAll: false,
                      displayLevelIds: [],
                    }, { syncToSheet: true })}
                    onLevelAllChange={(all) => updateFields({
                      displayLevelAll: all,
                      ...(all ? { displayLevelIds: [] } : {}),
                    }, { syncToSheet: true })}
                    onLevelIdsChange={(ids) => updateFields({
                      displayLevelAll: false,
                      displayLevelIds: ids,
                    }, { syncToSheet: true })}
                  />
                </InspectorSection>
              )}

              <InspectorSection
                id="general-assignments"
                title="Assignments"
                defaultOpen={false}
                summary={assignmentsSummary}
              >
                <div>
                  <Label>Server Assignment</Label>
                  {device.server && !device.serverId ? (
                    <Input value={device.server} onChange={e => update('server', e.target.value)} onBlur={commitToSheet} className="mt-1.5" />
                  ) : (
                    <Select value={device.serverId != null ? String(device.serverId) : 'none'} onValueChange={v => update('serverId', v === 'none' ? null : Number(v), { syncToSheet: true })}>
                      <SelectTrigger className="mt-1.5"><SelectValue placeholder="No server" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No server</SelectItem>
                        {servers.map(s => (
                          <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                <GroupAssignmentSelect
                  label="MDF / IDF Location"
                  description="Network closet or rack location for this device."
                  value={device.mdfIdfLocationId ?? null}
                  groups={mdfIdfLocations}
                  getGroupLabel={(l) => l.name}
                  onChange={(id) => update('mdfIdfLocationId', id)}
                  onAddGroup={onAddMdfIdfLocation}
                  noneLabel="No location"
                  addDialogTitle="Add MDF / IDF Location"
                  addNameLabel="Location name"
                  addPlaceholder="e.g. MDF-1, IDF-East"
                />
              </InspectorSection>

              <InspectorSection
                id="general-position"
                title="Position & Icon"
                defaultOpen={false}
                summary={`${Math.round(device.x || 0)}, ${Math.round(device.y || 0)} · ${Math.round(device.rotation || 0)}° · ${device.iconSize ?? 10}px`}
              >
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label>X</Label>
                    <Input type="number" value={Math.round(device.x || 0)} onChange={e => update('x', Number(e.target.value))} className="mt-1 text-xs" />
                  </div>
                  <div>
                    <Label>Y</Label>
                    <Input type="number" value={Math.round(device.y || 0)} onChange={e => update('y', Number(e.target.value))} className="mt-1 text-xs" />
                  </div>
                  <div>
                    <Label>Rotation</Label>
                    <Input type="number" value={device.rotation || 0} onChange={e => update('rotation', Number(e.target.value))} className="mt-1 text-xs" />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Icon Size</Label>
                    <span className="text-[10px] text-muted-foreground">{device.iconSize ?? 10}px</span>
                  </div>
                  <input
                    type="range" min={10} max={80} step={1}
                    value={device.iconSize ?? 10}
                    onChange={e => update('iconSize', Number(e.target.value))}
                    className="w-full h-1.5 accent-blue-500"
                  />
                </div>
              </InspectorSection>

              {isSign && (
                <InspectorSection
                  id="general-facing"
                  title="Facing / Sides"
                  defaultOpen={false}
                  summary={facingSummary}
                >
                  <div className="flex gap-1.5">
                    {[
                      { id: 'single', label: 'Single-sided' },
                      { id: 'dual',   label: 'Dual-sided'  },
                    ].map(opt => {
                      const active = (device.sided || 'single') === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => update('sided', opt.id)}
                          className={`flex-1 text-[10px] py-1 rounded border transition-colors ${
                            active
                              ? 'bg-primary/15 border-primary/50 text-foreground'
                              : 'border-border text-muted-foreground hover:bg-muted/40'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <Label className="text-[10px] text-muted-foreground">Rotation</Label>
                      <span className="text-[10px] text-muted-foreground">{Math.round(device.rotation || 0)}°</span>
                    </div>
                    <input
                      type="range" min={0} max={359} step={1}
                      value={device.rotation || 0}
                      onChange={e => update('rotation', Number(e.target.value))}
                      className="w-full h-1.5 accent-blue-500"
                    />
                  </div>

                  <div>
                    <Label className="text-[10px] text-muted-foreground">Bold Edge (display side)</Label>
                    <div className="grid grid-cols-4 gap-1 mt-1">
                      {[
                        { id: 'top',    label: 'Top'    },
                        { id: 'right',  label: 'Right'  },
                        { id: 'bottom', label: 'Bottom' },
                        { id: 'left',   label: 'Left'   },
                      ].map(opt => {
                        const current = Array.isArray(device.boldSides)
                          ? device.boldSides
                          : ((device.sided || 'single') === 'dual' ? [] : ['top']);
                        const active = current.includes(opt.id);
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => {
                              const next = active
                                ? current.filter(s => s !== opt.id)
                                : [...current, opt.id];
                              update('boldSides', next);
                            }}
                            className={`text-[10px] py-1 rounded border transition-colors ${
                              active
                                ? 'bg-primary/15 border-primary/50 text-foreground'
                                : 'border-border text-muted-foreground hover:bg-muted/40'
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </InspectorSection>
              )}

              {isCamera && (
                <InspectorSection
                  id="general-fov"
                  title="Direction / Field of View"
                  defaultOpen={false}
                  summary={(
                    <span className="inline-flex items-center gap-1.5 max-w-[180px]">
                      <span className="truncate">{fovRot}° · {fovCone}px</span>
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full border border-border shrink-0"
                        style={{ backgroundColor: fovColor }}
                        aria-hidden
                      />
                    </span>
                  )}
                >
                  {isDualLens ? (
                    <Tabs defaultValue="stream1">
                      <TabsList className="h-7">
                        <TabsTrigger value="stream1" className="text-[10px]">
                          S1 · {cameraTypeShortLabel(device.stream1?.streamType || device.type)}
                        </TabsTrigger>
                        <TabsTrigger value="stream2" className="text-[10px]">
                          S2 · {cameraTypeShortLabel(device.stream2?.streamType || device.type)}
                        </TabsTrigger>
                      </TabsList>
                      {[1, 2].map(n => {
                        const streamKey = `stream${n}`;
                        const rotVal = device[streamKey]?.rotation ?? 0;
                        const coneVal = device[streamKey]?.coneSize ?? device.coneSize ?? 40;
                        const colorVal = device[streamKey]?.color || '#348fe2';
                        return (
                          <TabsContent key={n} value={streamKey} className="space-y-2 mt-2">
                            <div className="grid grid-cols-2 gap-2 items-end">
                              <div className="min-w-0">
                                <Label className="text-[10px]">Cone Direction (offset °)</Label>
                                <Input type="number" min={-180} max={180} value={rotVal}
                                  onChange={e => updateStream(streamKey, 'rotation', Number(e.target.value))}
                                  className="mt-1 text-xs" />
                              </div>
                              <div className="flex items-center gap-2 pb-0.5">
                                <Label className="text-[10px]">Color</Label>
                                <input type="color" value={colorVal}
                                  onChange={e => updateStream(streamKey, 'color', e.target.value)}
                                  className="w-6 h-6 rounded cursor-pointer border border-border" />
                              </div>
                            </div>
                            <p className="text-[10px] text-muted-foreground">0° = same as device rotation. Rotate device on map to change base facing.</p>
                            <div>
                              <div className="flex items-center justify-between">
                                <Label className="text-[10px]">Cone Size</Label>
                                <span className="text-[10px] text-muted-foreground">{coneVal}px</span>
                              </div>
                              <input type="range" min={20} max={120} value={coneVal}
                                onChange={e => updateStream(streamKey, 'coneSize', Number(e.target.value))}
                                className="w-full mt-1 h-1.5 accent-blue-500" />
                            </div>
                          </TabsContent>
                        );
                      })}
                    </Tabs>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2 items-end">
                        <div className="min-w-0">
                          <Label className="text-[10px]">Cone Direction (offset °)</Label>
                          <Input type="number" min={-180} max={180} value={device.stream1?.rotation ?? 0}
                            onChange={e => updateStream('stream1', 'rotation', Number(e.target.value))}
                            className="mt-1 text-xs" />
                        </div>
                        <div className="flex items-center gap-2 pb-0.5">
                          <Label className="text-[10px]">Color</Label>
                          <input type="color" value={device.color || '#348fe2'}
                            onChange={e => update('color', e.target.value)}
                            className="w-6 h-6 rounded cursor-pointer border border-border" />
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground">0° = same as device rotation. Use the map rotate handle or Rotation field above to change base facing.</p>
                      <div>
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px]">Cone Size</Label>
                          <span className="text-[10px] text-muted-foreground">{device.coneSize ?? 40}px</span>
                        </div>
                        <input type="range" min={20} max={120} value={device.coneSize ?? 40}
                          onChange={e => update('coneSize', Number(e.target.value))}
                          className="w-full mt-1 h-1.5 accent-blue-500" />
                      </div>
                    </div>
                  )}
                </InspectorSection>
              )}
            </TabsContent>

            {/* Network Tab */}
            <TabsContent value="network" className="mt-0 flex flex-col gap-1.5">
              <InspectorSection id="network-connection" title="Connection" defaultOpen summary={getDeviceIp() || '—'}>
              {(isCamera || isSign) && sheetSync && (
                <p className="text-[10px] text-muted-foreground">
                  Network fields save to Google Sheets when you leave each field.
                </p>
              )}
              <div className="flex items-center justify-between">
                <Label>DHCP</Label>
                <Switch checked={device.dhcp || false} onCheckedChange={v => update('dhcp', v)} />
              </div>

              {isCamera && isDualLens ? (
                <Tabs defaultValue="stream1">
                  <TabsList className="h-7">
                    <TabsTrigger value="stream1" className="text-[10px]">
                      S1 · {cameraTypeShortLabel(device.stream1?.streamType || device.type)}
                    </TabsTrigger>
                    <TabsTrigger value="stream2" className="text-[10px]">
                      S2 · {cameraTypeShortLabel(device.stream2?.streamType || device.type)}
                    </TabsTrigger>
                  </TabsList>
                  {[1, 2].map(n => (
                    <TabsContent key={n} value={`stream${n}`} className="space-y-3 mt-2">
                      <div className="rounded border border-border/60 bg-muted/15 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Sheet ID</p>
                        <p className="text-xs font-medium font-mono">{streamSyncSheetName(device, n)}</p>
                      </div>
                      <div>
                        <Label>Stream Type</Label>
                        <Select
                          value={device[`stream${n}`]?.streamType || device.type}
                          onValueChange={v => updateStream(`stream${n}`, 'streamType', v, { syncToSheet: true })}
                        >
                          <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {deviceTypes.cameras.map(c => (
                              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>IP Address</Label>
                        <Input
                          value={getStreamField(`stream${n}`, 'ipAddress')}
                          onChange={e => updateStream(`stream${n}`, 'ipAddress', e.target.value)}
                          onBlur={commitToSheet}
                          placeholder="192.168.1.100"
                          disabled={device.dhcp}
                          className="mt-1.5"
                        />
                      </div>
                      <div>
                        <Label>Port</Label>
                        <Input
                          value={getStreamField(`stream${n}`, 'port') || '554'}
                          onChange={e => updateStream(`stream${n}`, 'port', e.target.value)}
                          onBlur={commitToSheet}
                          placeholder="554"
                          disabled={device.dhcp}
                          className="mt-1.5"
                        />
                      </div>
                      <div>
                        <Label>RTSP URL</Label>
                        <Input
                          value={getStreamField(`stream${n}`, 'externalUrl')}
                          onChange={e => updateStream(`stream${n}`, 'externalUrl', e.target.value)}
                          onBlur={commitToSheet}
                          placeholder="rtsp://..."
                          className="mt-1.5 font-mono text-xs"
                        />
                      </div>
                    </TabsContent>
                  ))}
                </Tabs>
              ) : (
                <>
                  <div>
                    <Label>IP Address</Label>
                    <Input
                      value={getDeviceIp()}
                      onChange={e => isCamera ? updateStream('stream1', 'ipAddress', e.target.value) : update('ipAddress', e.target.value)}
                      onBlur={isCamera || isSign ? commitToSheet : undefined}
                      placeholder="192.168.1.100"
                      disabled={device.dhcp}
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label>Port</Label>
                    <Input
                      value={getDevicePort() || (isCamera ? '554' : '')}
                      onChange={e => isCamera ? updateStream('stream1', 'port', e.target.value) : update('port', e.target.value)}
                      onBlur={isCamera || isSign ? commitToSheet : undefined}
                      placeholder={isCamera ? '554' : '80'}
                      disabled={device.dhcp}
                      className="mt-1.5"
                    />
                  </div>
                  {isSign && !signUsesInserts(device) && (
                    <div>
                      <Label>Serial Address</Label>
                      <Input
                        value={device.serialAddress || ''}
                        onChange={e => update('serialAddress', e.target.value)}
                        onBlur={commitToSheet}
                        placeholder="e.g. COM1 or /dev/ttyUSB0"
                        disabled={device.dhcp}
                        className="mt-1.5"
                      />
                    </div>
                  )}
                  {isSign && signUsesInserts(device) && (
                    <p className="text-[10px] text-muted-foreground">
                      Serial addresses are set per insert on the General tab. IP/port are shared across inserts.
                    </p>
                  )}
                  {isCamera && (
                    <div>
                      <Label>RTSP URL</Label>
                      <Input
                        value={getDeviceRtsp()}
                        onChange={e => updateStream('stream1', 'externalUrl', e.target.value)}
                        onBlur={commitToSheet}
                        placeholder="rtsp://..."
                        className="mt-1.5 font-mono text-xs"
                      />
                    </div>
                  )}
                </>
              )}

              {!isCamera && !isSensor && (
                <div>
                  <Label>MAC Address</Label>
                  <Input
                    value={device.macAddress || ''}
                    onChange={e => update('macAddress', e.target.value)}
                    placeholder="00:00:00:00:00:00"
                    className="mt-1.5 font-mono"
                  />
                </div>
              )}
              </InspectorSection>
            </TabsContent>

            {/* Media Tab (Camera only) */}
            {isCamera && (
              <TabsContent value="media" className="mt-0 space-y-3">
                <div>
                  <Label>Camera View Image</Label>
                  <div className="mt-1.5 border border-dashed border-border rounded-lg p-4 text-center">
                    {device.viewImage ? (
                      <div className="relative">
                        <img src={device.viewImage} alt="Camera view" className="max-h-40 mx-auto rounded" />
                        <button
                          onClick={() => update('viewImage', null)}
                          className="absolute top-1 right-1 p-1 rounded bg-background/80 hover:bg-background cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <PhotoPickControls
                        accept="image/*"
                        uploadLabel="Upload photo"
                        hint="Photos are resized automatically so shared saves stay under size limits."
                        onFiles={async (files) => {
                          try {
                            const prepared = await prepareDevicePhotoFromFile(files[0]);
                            if (!prepared?.dataUrl) return;
                            update('viewImage', prepared.dataUrl);
                            if (prepared.compressed) {
                              onToast?.('Camera photo resized for sharing');
                            }
                          } catch (err) {
                            onToast?.(err.message || 'Could not add photo.');
                          }
                        }}
                      />
                    )}
                  </div>
                </div>
              </TabsContent>
            )}

            {/* Photos Tab (Signs only) - multiple images */}
            {isSign && (
              <TabsContent value="photos" className="mt-0 space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <Label>Sign Photos</Label>
                    <span className="text-[10px] text-muted-foreground">
                      {(device.signImages?.length || 0)} photo{(device.signImages?.length || 0) === 1 ? '' : 's'}
                    </span>
                  </div>

                  {/* Existing photos */}
                  {device.signImages?.length > 0 && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {device.signImages.map((src, idx) => (
                        <div key={idx} className="relative group border border-border rounded overflow-hidden bg-muted/30">
                          <img src={src} alt={`Sign photo ${idx + 1}`} className="w-full h-24 object-cover" />
                          <button
                            onClick={() => {
                              const next = (device.signImages || []).filter((_, i) => i !== idx);
                              update('signImages', next);
                            }}
                            className="absolute top-1 right-1 p-1 rounded bg-background/80 hover:bg-destructive hover:text-destructive-foreground cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Remove photo"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add photos — camera on phone/tablet, or upload from library */}
                  <div className="mt-2">
                    <PhotoPickControls
                      multiple
                      accept="image/*"
                      uploadLabel="Upload photo(s)"
                      disabled={(device.signImages?.length || 0) >= MAX_SIGN_PHOTOS}
                      hint={`Up to ${MAX_SIGN_PHOTOS} photos. Large shots are resized automatically for sharing.`}
                      onFiles={async (files) => {
                        const existing = device.signImages || [];
                        const remaining = MAX_SIGN_PHOTOS - existing.length;
                        if (remaining <= 0) {
                          onToast?.(`Limit is ${MAX_SIGN_PHOTOS} photos per sign.`);
                          return;
                        }
                        try {
                          const prepared = await prepareDevicePhotosFromFiles(files, {
                            maxCount: remaining,
                          });
                          if (!prepared.length) return;
                          update('signImages', [...existing, ...prepared.map((p) => p.dataUrl)]);
                          const messages = [];
                          if (files.length > remaining) {
                            messages.push(`Added ${prepared.length} of ${files.length} (max ${MAX_SIGN_PHOTOS})`);
                          }
                          if (prepared.some((p) => p.compressed)) {
                            messages.push('Photos resized for sharing');
                          }
                          if (messages.length) onToast?.(messages.join(' · '));
                        } catch (err) {
                          onToast?.(err.message || 'Could not add photos.');
                        }
                      }}
                    />
                  </div>
                </div>
              </TabsContent>
            )}
            {isCamera && (
              <TabsContent value="traffic" className="mt-0 flex flex-col gap-1.5">
                <InspectorSection
                  id="traffic-direction"
                  title="Direction & target"
                  defaultOpen
                  summary={trafficDirection ? trafficDirection.toUpperCase() : '—'}
                >
                <div role="group" aria-labelledby="traffic-direction-label">
                  <Label id="traffic-direction-label">Back of car is</Label>
                  <div className="flex gap-2 mt-1.5">
                    {[
                      { id: 'in', label: 'IN', icon: ArrowDown },
                      { id: 'out', label: 'OUT', icon: ArrowUp },
                    ].map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={trafficDirection === id}
                        onClick={() => updateTrafficFlow('direction', trafficDirection === id ? '' : id, { syncToSheet: true })}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-medium cursor-pointer transition-all border ${
                          trafficDirection === id
                            ? 'bg-primary/10 text-primary border-primary/20'
                            : 'bg-muted text-muted-foreground border-transparent hover:bg-accent'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {showFlowTarget && (
                  <div>
                    <Label>
                      {trafficDirection === 'in' ? `Into ${targetNoun}` : trafficDirection === 'out' ? `Out of ${targetNoun}` : `For ${targetNoun}`}
                    </Label>
                    <Select
                      value={primaryTargetKey}
                      onValueChange={v => {
                        const { levelId, zoneId } = parseFlowTargetKey(v);
                        updateTrafficFlowFields({ level: levelId, zone: zoneId }, { syncToSheet: true });
                      }}
                    >
                      <SelectTrigger className="mt-1.5 text-xs">
                        <SelectValue placeholder={`Select ${targetNoun}...`}>
                          {primaryTargetKey ? primaryTargetName : null}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {targetOptions.map(option => (
                          <SelectItem
                            key={option.key}
                            value={option.key}
                            className={option.isZone ? 'pl-8' : undefined}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {hasZones && (
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Pick a zone to count traffic moving in or out of that zone instead of the whole level.
                      </p>
                    )}
                  </div>
                )}

                {showFlowTarget && (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <Label>Opposite flow for other {targetNoun}s</Label>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {hasZones
                          ? 'Ramp or zone-transition camera — also counts the inverse direction for the selected targets.'
                          : 'Ramp camera — also counts the inverse direction for selected levels.'}
                      </p>
                    </div>
                    <Switch
                      checked={isMultiLevelCamera}
                      onCheckedChange={(checked) => {
                        const flow = device.trafficFlow || {};
                        onUpdateDevice(device.id, {
                          trafficFlow: {
                            ...flow,
                            multiLevel: checked,
                            ...(checked ? {} : { destinations: [] }),
                          },
                        }, { syncToSheet: true });
                      }}
                      aria-label="Opposite flow for other levels"
                    />
                  </div>
                )}

                <div>
                  <Label>Coming from</Label>
                  <Input
                    value={device.trafficFlow?.comingFrom || ''}
                    onChange={e => updateTrafficFlow('comingFrom', e.target.value)}
                    onBlur={commitToSheet}
                    placeholder="e.g. Street, Ramp B1"
                    className="mt-1.5"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Optional source label for this camera&apos;s primary flow.
                  </p>
                </div>

                </InspectorSection>

                {isMultiLevelCamera && (
                <InspectorSection
                  id="traffic-opposite"
                  title="Opposite-flow targets"
                  defaultOpen
                  summary={`${destinationKeys.length} target${destinationKeys.length === 1 ? '' : 's'}`}
                >
                  <div>
                    <Label>{hasZones ? 'Opposite-Flow Targets' : 'Opposite-Flow Levels'}</Label>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      This camera counts the inverse direction for these {hasZones ? 'targets' : 'levels'} (virtual counter).
                    </p>
                    <div className="mt-1.5 space-y-1">
                      {destinationOptions.map(option => {
                        const isSelected = destinationKeys.includes(option.key);
                        return (
                          <button
                            key={option.key}
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => {
                              const next = isSelected
                                ? destinationKeys.filter(d => d !== option.key)
                                : [...destinationKeys, option.key];
                              updateTrafficFlow('destinations', next, { syncToSheet: true });
                            }}
                            className={`w-full text-left px-3 py-1.5 rounded-md text-xs cursor-pointer transition-all ${
                              isSelected ? 'bg-primary/10 text-primary border border-primary/20' : 'bg-muted text-muted-foreground hover:bg-accent'
                            } ${option.isZone ? 'pl-6' : ''}`}
                          >
                            {option.label}
                            {isSelected && trafficDirection && (
                              <span className="float-right font-semibold uppercase">{invertTrafficDirection(trafficDirection)}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </InspectorSection>
                )}

                {trafficDirection && (
                  <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Flow summary
                    </p>
                    <p className="text-xs">
                      <span className="font-semibold uppercase">{trafficDirection}</span>
                      {' '}for {primaryTargetName}
                      {primaryLevelValue && currentLevel && primaryLevelValue !== currentLevel.id?.toString() && (
                        <span className="text-muted-foreground"> (virtual counter)</span>
                      )}
                    </p>
                    {isMultiLevelCamera && destinationKeys.map(key => {
                      const { levelId, zoneId } = parseFlowTargetKey(key);
                      const label = flowTargetLabel(levels, levelId, zoneId, '');
                      if (!label) return null;
                      return (
                        <p key={key} className="text-xs">
                          <span className="font-semibold uppercase">{invertTrafficDirection(trafficDirection)}</span>
                          {' '}for {label}
                          <span className="text-muted-foreground"> (virtual counter)</span>
                        </p>
                      );
                    })}
                  </div>
                )}
              </TabsContent>
            )}
          </div>
        </ScrollArea>
      </Tabs>

      {isSign && (
        <div className="px-3 py-2 border-t border-border shrink-0 bg-[#151c23]">
          <Label htmlFor="sign-notes" className="text-[10px] text-muted-foreground">Notes</Label>
          <Textarea
            id="sign-notes"
            value={device.notes || ''}
            onChange={(e) => update('notes', e.target.value)}
            placeholder="Install notes, wiring, access, etc."
            rows={3}
            className="mt-1 text-xs min-h-[4.5rem] resize-y"
          />
        </div>
      )}

      {exportError && (
        <div className="px-3 py-2 border-t border-destructive/30 bg-destructive/10 text-destructive text-xs">
          {exportError}
        </div>
      )}

      {/* Footer Actions */}
      <div className="p-3 border-t border-border flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          disabled={!!device.pendingPlacement}
          title={device.pendingPlacement ? 'Already unplaced' : 'Keep device data, remove from map'}
          onClick={() => onRemoveDevice(device.id)}
        >
          Unplace
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Duplicate device"
          onClick={() => onCopyDevice(device.id)}
        >
          <Copy className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="destructive"
          size="sm"
          title="Permanently delete device"
          onClick={() => onDeleteDevice(device.id)}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </motion.div>
  );
}
