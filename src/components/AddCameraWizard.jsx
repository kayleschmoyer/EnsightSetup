import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Switch } from './ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { DeviceIcon } from './DeviceIcons';
import {
  Camera, ChevronLeft, Server, ArrowDown, ArrowUp
} from 'lucide-react';
import {
  normalizeTrafficDirection,
  invertTrafficDirection,
  flowDestinationOptions,
  flowTargetKey,
  flowTargetLabel,
  flowTargetOptions,
  levelsHaveZones,
  normalizeFlowDestinations,
  parseFlowTargetKey,
  resolveFlowTargetKey,
} from '../lib/trafficFlowUtils';
import { defaultSecondStreamType } from '../lib/deviceNamingUtils';

/* ── Inline SVG icons for hardware types ── */
function BulletCameraIcon({ className, ...props }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} {...props}>
      {/* Body cylinder */}
      <rect x="10" y="22" width="36" height="20" rx="4" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2.5" />
      {/* Lens hood */}
      <rect x="46" y="25" width="10" height="14" rx="2" fill="currentColor" opacity="0.25" stroke="currentColor" strokeWidth="2" />
      {/* Lens circle */}
      <circle cx="52" cy="32" r="4" fill="currentColor" opacity="0.4" />
      <circle cx="52" cy="32" r="2" fill="currentColor" />
      {/* Mount bracket */}
      <path d="M18 42 L18 52 L10 52" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* IR LEDs */}
      <circle cx="20" cy="28" r="1.5" fill="currentColor" opacity="0.5" />
      <circle cx="20" cy="36" r="1.5" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

function DualLensCameraIcon({ className, ...props }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} {...props}>
      {/* Body */}
      <rect x="8" y="16" width="48" height="28" rx="5" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2.5" />
      {/* Left lens */}
      <circle cx="24" cy="30" r="8" fill="currentColor" opacity="0.1" stroke="currentColor" strokeWidth="2" />
      <circle cx="24" cy="30" r="4" fill="currentColor" opacity="0.3" />
      <circle cx="24" cy="30" r="2" fill="currentColor" />
      {/* Right lens */}
      <circle cx="42" cy="30" r="8" fill="currentColor" opacity="0.1" stroke="currentColor" strokeWidth="2" />
      <circle cx="42" cy="30" r="4" fill="currentColor" opacity="0.3" />
      <circle cx="42" cy="30" r="2" fill="currentColor" />
      {/* Mount bracket */}
      <path d="M32 44 L32 54 L24 54" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Status LED */}
      <circle cx="33" cy="20" r="1.5" fill="currentColor" opacity="0.6" />
    </svg>
  );
}

const STREAM_TYPES = [
  { id: 'cam-fli', label: 'FLI' },
  { id: 'cam-lpr', label: 'LPR' },
  { id: 'cam-people', label: 'People' },
];

const HARDWARE_TYPES = [
  { id: 'bullet', label: 'Bullet Camera', streams: 1, Icon: BulletCameraIcon },
  { id: 'dual-lens', label: 'Dual Lens Camera', streams: 2, Icon: DualLensCameraIcon },
];

/**
 * AddCameraWizard – multi-step wizard for adding a camera device.
 *
 * Step 1: Choose hardware type (Bullet or Dual Lens)
 * Step 2: Choose camera/stream type (FLI, LPR, People Counting)
 * Step 3: Configure stream(s) – name, MAC, IP, port, type, traffic flow, RTSP, server
 */
export default function AddCameraWizard({
  open,
  onOpenChange,
  initialStreamType = null,
  levels = [],
  currentLevel,
  servers = [],
  onAddCamera,
}) {
  // Wizard state
  const [step, setStep] = useState(1);
  const [hardwareType, setHardwareType] = useState(null);
  const [streamType, setStreamType] = useState(null); // cam-fli | cam-lpr | cam-people
  const [activeStream, setActiveStream] = useState(1);

  // Form state
  const [form, setForm] = useState(() => getDefaultForm());
  const [submitError, setSubmitError] = useState('');

  function getDefaultForm() {
    return {
      name: '',
      friendlyName: '',
      macAddress: '',
      stream1: {
        ipAddress: '',
        port: '554',
        streamType: 'cam-fli',
        rtspUrl: '',
        trafficFlow: { direction: '', level: '', zone: '', comingFrom: '', multiLevel: false, destinations: [] },
      },
      stream2: {
        ipAddress: '',
        port: '554',
        streamType: 'cam-lpr',
        rtspUrl: '',
        trafficFlow: { direction: '', level: '', zone: '', comingFrom: '', multiLevel: false, destinations: [] },
      },
      serverId: null,
    };
  }

  const comingFromOptions = useMemo(() => {
    const opts = [
      { id: 'street', label: 'Street' },
      { id: 'site-entry', label: 'Site Entry' },
      { id: 'site-exit', label: 'Site Exit' },
    ];
    levels.forEach(l => {
      if (l.id !== currentLevel?.id) {
        opts.push({ id: `level-${l.id}`, label: l.name });
      }
    });
    return opts;
  }, [levels, currentLevel]);

  const reset = useCallback(() => {
    setStep(1);
    setHardwareType(null);
    setStreamType(null);
    setActiveStream(1);
    setSubmitError('');
    setForm(getDefaultForm());
  }, []);

  // When the dialog opens with an initialStreamType, pre-set stream 1 and
  // the complementary stream 2 type (FLI↔LPR) so we skip step 2.
  useEffect(() => {
    if (open && initialStreamType) {
      setStreamType(initialStreamType);
      setForm(f => ({
        ...f,
        stream1: { ...f.stream1, streamType: initialStreamType },
        stream2: { ...f.stream2, streamType: defaultSecondStreamType(initialStreamType) },
      }));
    }
  }, [open, initialStreamType]);

  const handleClose = useCallback((val) => {
    if (!val) reset();
    onOpenChange(val);
  }, [onOpenChange, reset]);

  // Step 1 → Step 3 (skip step 2 if stream type already known)
  const selectHardware = useCallback((hw) => {
    setHardwareType(hw);
    if (streamType) {
      // Dual-lens stream 2 defaults to the complementary type (FLI↔LPR).
      const stream2Type = hw === 'dual-lens'
        ? defaultSecondStreamType(streamType)
        : streamType;
      setForm(f => ({
        ...f,
        stream1: { ...f.stream1, streamType },
        stream2: { ...f.stream2, streamType: stream2Type },
      }));
      setStep(3);
    } else {
      setStep(2);
    }
  }, [streamType]);

  // Step 2 → Step 3
  const selectStreamType = useCallback((type) => {
    setStreamType(type);
    setForm(f => ({
      ...f,
      stream1: { ...f.stream1, streamType: type },
      stream2: {
        ...f.stream2,
        streamType: hardwareType === 'dual-lens' ? defaultSecondStreamType(type) : type,
      },
    }));
    setStep(3);
  }, [hardwareType]);

  const updateStreamField = useCallback((streamNum, field, value) => {
    const key = `stream${streamNum}`;
    setForm(f => ({
      ...f,
      [key]: { ...f[key], [field]: value },
    }));
    // Keep the wizard's top-level streamType in sync with stream 1's type so
    // any wizard chrome that still reads it (e.g. step-2 highlight on back)
    // reflects the user's latest choice. Stream 2's type is per-stream only.
    if (streamNum === 1 && field === 'streamType') {
      setStreamType(value);
    }
  }, []);

  const updateTrafficFlow = useCallback((streamNum, field, value) => {
    const key = `stream${streamNum}`;
    setForm(f => ({
      ...f,
      [key]: {
        ...f[key],
        trafficFlow: { ...f[key].trafficFlow, [field]: value },
      },
    }));
  }, []);

  const handleSubmit = useCallback(() => {
    setSubmitError('');

    const stream1Direction = normalizeTrafficDirection(form.stream1.trafficFlow.direction);
    const stream1 = {
      ipAddress: form.stream1.ipAddress,
      port: form.stream1.port,
      externalUrl: form.stream1.rtspUrl,
      streamType: form.stream1.streamType,
      ...(stream1Direction ? { direction: stream1Direction } : {}),
    };

    // Use the current per-stream type from the form (which the user can edit
    // in step 3), not the top-level `streamType` wizard state, which only
    // tracks the initial selection from step 2. For dual-lens cameras the
    // device's primary type follows stream1.
    const primaryType = form.stream1.streamType || streamType;

    // Opposite-flow levels only apply to flagged multi-level (ramp) cameras
    const stream1Flow = form.stream1.trafficFlow;
    const stream1MultiLevel = Boolean(stream1Flow.multiLevel);
    const stream1PrimaryLevel = stream1Flow.level || currentLevel?.id?.toString() || '';
    // Drop only the camera's own primary target — other zones on that level
    // are valid opposite-flow destinations.
    const stream1PrimaryTarget = flowTargetKey(stream1PrimaryLevel, stream1Flow.zone);
    const stream1Destinations = stream1MultiLevel
      ? normalizeFlowDestinations(stream1Flow.destinations).filter(d => d !== stream1PrimaryTarget)
      : [];

    const device = {
      type: primaryType,
      name: form.name || 'Camera',
      friendlyName: form.friendlyName || '',
      macAddress: form.macAddress,
      hardwareType: hardwareType,
      stream1,
      trafficFlow: {
        direction: stream1Direction,
        level: stream1PrimaryLevel,
        zone: stream1Flow.zone || '',
        comingFrom: stream1Flow.comingFrom,
        multiLevel: stream1MultiLevel,
        destinations: stream1Destinations,
      },
      serverId: form.serverId,
      ipAddress: form.stream1.ipAddress,
      port: form.stream1.port,
    };

    if (hardwareType === 'dual-lens') {
      const stream2Direction = normalizeTrafficDirection(form.stream2.trafficFlow.direction);
      const stream2Flow = form.stream2.trafficFlow;
      const stream2MultiLevel = Boolean(stream2Flow.multiLevel);
      const stream2PrimaryLevel = stream2Flow.level || currentLevel?.id?.toString() || '';
      const stream2PrimaryTarget = flowTargetKey(stream2PrimaryLevel, stream2Flow.zone);
      const stream2Destinations = stream2MultiLevel
        ? normalizeFlowDestinations(stream2Flow.destinations).filter(d => d !== stream2PrimaryTarget)
        : [];
      device.stream2 = {
        ipAddress: form.stream2.ipAddress,
        port: form.stream2.port,
        externalUrl: form.stream2.rtspUrl,
        streamType: form.stream2.streamType,
        ...(stream2Direction ? { direction: stream2Direction } : {}),
        trafficFlow: {
          direction: stream2Direction,
          level: stream2PrimaryLevel,
          zone: stream2Flow.zone || '',
          comingFrom: stream2Flow.comingFrom,
          multiLevel: stream2MultiLevel,
          destinations: stream2Destinations,
        },
      };
    }

    onAddCamera(device);
    handleClose(false);
  }, [form, streamType, hardwareType, currentLevel, onAddCamera, handleClose]);

  const isDualLens = hardwareType === 'dual-lens';
  const currentStream = activeStream === 1 ? form.stream1 : form.stream2;
  const streamDirection = normalizeTrafficDirection(currentStream.trafficFlow.direction);
  const isMultiLevel = Boolean(currentStream.trafficFlow.multiLevel);
  // Level the primary "back of car is" flow applies to — defaults to the camera's own level
  const primaryLevelValue = currentStream.trafficFlow.level || currentLevel?.id?.toString() || '';
  const primaryLevel = levels.find(l => l.id.toString() === primaryLevelValue) || currentLevel || null;
  // A flow can target a whole level or one zone on it.
  const primaryTargetKey = resolveFlowTargetKey(levels, primaryLevelValue, currentStream.trafficFlow.zone);
  const primaryTargetName = flowTargetLabel(
    levels,
    primaryLevelValue,
    currentStream.trafficFlow.zone,
    currentLevel?.name || 'this level',
  );
  const targetOptions = flowTargetOptions(levels);
  const hasZones = levelsHaveZones(levels);
  const showFlowTarget = levels.length > 1 || hasZones;
  const targetNoun = hasZones ? 'level or zone' : 'level';
  const streamDestinations = normalizeFlowDestinations(currentStream.trafficFlow.destinations);
  const destinationOptions = flowDestinationOptions(levels, primaryTargetKey);
  const destinationNames = streamDestinations
    .map(key => {
      const { levelId, zoneId } = parseFlowTargetKey(key);
      return flowTargetLabel(levels, levelId, zoneId, '');
    })
    .filter(Boolean);
  const hwInfo = HARDWARE_TYPES.find(h => h.id === hardwareType);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">Add Camera</DialogTitle>
        <DialogDescription className="sr-only">
          Step-by-step wizard for adding a camera device, including hardware type, stream type, and configuration.
        </DialogDescription>
        {/* Active section label */}
        <div className="flex items-center justify-center gap-2 border-b border-border px-6 pt-5 pb-3">
          <Camera className="w-5 h-5 text-primary" />
          <span className="text-sm font-semibold text-primary">Cameras</span>
        </div>

        <ScrollArea className="max-h-[70vh]">
          <div className="p-5">
            <AnimatePresence mode="wait">
              {/* Step 1: Choose Hardware Type */}
              {step === 1 && (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-4"
                >
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">Select Camera Type</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {HARDWARE_TYPES.map(hw => (
                      <button
                        key={hw.id}
                        onClick={() => selectHardware(hw.id)}
                        className="flex flex-col items-center gap-2 p-5 rounded-xl border border-border hover:border-primary/50 hover:bg-primary/5 cursor-pointer transition-all group"
                      >
                        <hw.Icon className="w-10 h-10 text-muted-foreground group-hover:text-primary transition-colors" />
                        <span className="font-medium text-sm">{hw.label}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {hw.streams} stream{hw.streams > 1 ? 's' : ''}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Step 2: Choose Stream Type */}
              {step === 2 && (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-4"
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setStep(1)}
                      className="p-1 rounded-md hover:bg-accent cursor-pointer"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <h3 className="font-semibold">
                      {hwInfo?.label} — Select Type
                    </h3>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {STREAM_TYPES.map(st => (
                      <button
                        key={st.id}
                        onClick={() => selectStreamType(st.id)}
                        className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border hover:border-primary/50 hover:bg-primary/5 cursor-pointer transition-all group"
                      >
                        <DeviceIcon type={st.id} className="w-7 h-7 text-muted-foreground group-hover:text-primary transition-colors" />
                        <span className="font-medium text-sm">{st.label}</span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Step 3: Configuration */}
              {step === 3 && (
                <motion.div
                  key="step3"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-4"
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setStep(initialStreamType ? 1 : 2)}
                      className="p-1 rounded-md hover:bg-accent cursor-pointer"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <h3 className="font-semibold">Add Camera — Configuration</h3>
                  </div>

                  {/* Stream Tabs (only for dual lens) */}
                  {isDualLens && (
                    <div className="flex gap-2">
                      {[1, 2].map(num => {
                        const st = num === 1 ? form.stream1.streamType : form.stream2.streamType;
                        const label = STREAM_TYPES.find(t => t.id === st)?.label || 'Stream';
                        return (
                          <button
                            key={num}
                            onClick={() => setActiveStream(num)}
                            className={`flex-1 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all ${
                              activeStream === num
                                ? 'bg-primary/20 text-primary border border-primary/40'
                                : 'bg-muted text-muted-foreground border border-transparent'
                            }`}
                          >
                            Stream {num} · {label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Camera Name */}
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground tracking-wide">Device Name</Label>
                    <Input
                      value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Auto (e.g. F11)"
                      className="mt-1.5"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">Shown on the map. Leave blank to auto-generate.</p>
                  </div>

                  {/* Friendly Name */}
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground tracking-wide">Friendly Name</Label>
                    <Input
                      value={form.friendlyName}
                      onChange={e => setForm(f => ({ ...f, friendlyName: e.target.value }))}
                      placeholder="e.g. North Entry FLI"
                      className="mt-1.5"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">Reference label — not shown on the map.</p>
                  </div>

                  {/* MAC Address */}
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground tracking-wide">MAC Address</Label>
                    <Input
                      value={form.macAddress}
                      onChange={e => setForm(f => ({ ...f, macAddress: e.target.value }))}
                      placeholder="00:1A:2B:3C:4D:5E"
                      className="mt-1.5 font-mono"
                    />
                  </div>

                  {/* IP Address + Port */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <Label className="text-xs uppercase text-muted-foreground tracking-wide">IP Address</Label>
                      <Input
                        value={currentStream.ipAddress}
                        onChange={e => updateStreamField(activeStream, 'ipAddress', e.target.value)}
                        placeholder="10.16.6.45"
                        className="mt-1.5 font-mono"
                      />
                    </div>
                    <div>
                      <Label className="text-xs uppercase text-muted-foreground tracking-wide">Port</Label>
                      <Input
                        value={currentStream.port}
                        onChange={e => updateStreamField(activeStream, 'port', e.target.value)}
                        placeholder="80"
                        className="mt-1.5 font-mono"
                      />
                    </div>
                  </div>

                  {/* Stream Type Toggle */}
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground tracking-wide">Stream Type</Label>
                    <div className="flex gap-2 mt-1.5">
                      {STREAM_TYPES.map(st => (
                        <button
                          key={st.id}
                          onClick={() => updateStreamField(activeStream, 'streamType', st.id)}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all ${
                            currentStream.streamType === st.id
                              ? 'bg-primary/20 text-primary border border-primary/40'
                              : 'bg-muted text-muted-foreground border border-transparent'
                          }`}
                        >
                          {st.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Traffic Flow */}
                  <div>
                    <div className="rounded-lg border border-border p-3 space-y-3">
                      <div role="group" aria-labelledby="wizard-traffic-direction-label">
                        <Label id="wizard-traffic-direction-label">Back of car is</Label>
                        <div className="flex gap-2 mt-1.5">
                          <button
                            type="button"
                            aria-pressed={streamDirection === 'in'}
                            onClick={() => updateTrafficFlow(activeStream, 'direction', streamDirection === 'in' ? '' : 'in')}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium cursor-pointer transition-all border ${
                              streamDirection === 'in'
                                ? 'bg-primary/10 text-primary border-primary/20'
                                : 'bg-muted text-muted-foreground border-transparent hover:bg-accent'
                            }`}
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                            IN
                          </button>
                          <button
                            type="button"
                            aria-pressed={streamDirection === 'out'}
                            onClick={() => updateTrafficFlow(activeStream, 'direction', streamDirection === 'out' ? '' : 'out')}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-medium cursor-pointer transition-all border ${
                              streamDirection === 'out'
                                ? 'bg-primary/10 text-primary border-primary/20'
                                : 'bg-muted text-muted-foreground border-transparent hover:bg-accent'
                            }`}
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                            OUT
                          </button>
                        </div>
                      </div>

                      {/* Which level (or zone on it) the primary flow applies to */}
                      {showFlowTarget && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {streamDirection === 'in' ? `Into ${targetNoun}:` : streamDirection === 'out' ? `Out of ${targetNoun}:` : `For ${targetNoun}:`}
                          </span>
                          <Select
                            value={primaryTargetKey}
                            onValueChange={v => {
                              const { levelId, zoneId } = parseFlowTargetKey(v);
                              updateTrafficFlow(activeStream, 'level', levelId);
                              updateTrafficFlow(activeStream, 'zone', zoneId);
                            }}
                          >
                            <SelectTrigger className="flex-1 text-xs">
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
                        </div>
                      )}

                      {/* Opposite flow for other targets — opt-in (ramp / zone-transition cameras) */}
                      {showFlowTarget && (
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-xs font-medium block">Opposite flow for other {targetNoun}s</span>
                            <span className="text-[10px] text-muted-foreground block">
                              {hasZones
                                ? 'Ramp or zone-transition camera — also counts the inverse direction for the targets below'
                                : 'Ramp camera — also counts the inverse direction for the levels below'}
                            </span>
                          </div>
                          <Switch
                            checked={isMultiLevel}
                            onCheckedChange={(checked) => {
                              updateTrafficFlow(activeStream, 'multiLevel', checked);
                              if (!checked) updateTrafficFlow(activeStream, 'destinations', []);
                            }}
                            aria-label="Opposite flow for other levels"
                          />
                        </div>
                      )}

                      {/* Opposite-flow targets (only for flagged ramp / zone-transition cameras) */}
                      {isMultiLevel && (
                        <div className="space-y-1">
                          {destinationOptions.map(option => {
                            const isSelected = streamDestinations.includes(option.key);
                            return (
                              <button
                                key={option.key}
                                type="button"
                                aria-pressed={isSelected}
                                onClick={() => {
                                  const next = isSelected
                                    ? streamDestinations.filter(d => d !== option.key)
                                    : [...streamDestinations, option.key];
                                  updateTrafficFlow(activeStream, 'destinations', next);
                                }}
                                className={`w-full text-left px-3 py-1.5 rounded-md text-xs cursor-pointer transition-all ${
                                  isSelected ? 'bg-primary/10 text-primary border border-primary/20' : 'bg-muted text-muted-foreground hover:bg-accent'
                                } ${option.isZone ? 'pl-6' : ''}`}
                              >
                                {option.label}
                                {isSelected && streamDirection && (
                                  <span className="float-right font-semibold uppercase">{invertTrafficDirection(streamDirection)}</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Derived flow summary */}
                      {streamDirection && primaryLevel && isMultiLevel && destinationNames.length > 0 && (
                        <p className="text-[10px] text-muted-foreground leading-snug rounded-md bg-muted/40 border border-border/60 px-2 py-1.5">
                          <span className="font-semibold text-foreground/80 uppercase">{streamDirection}</span>
                          {' '}for {primaryTargetName} ·{' '}
                          <span className="font-semibold text-foreground/80 uppercase">{invertTrafficDirection(streamDirection)}</span>
                          {' '}for {destinationNames.join(', ')} (virtual — same camera counts both)
                        </p>
                      )}

                      {/* Coming From */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Coming from:</span>
                        <Select
                          value={currentStream.trafficFlow.comingFrom || ''}
                          onValueChange={v => updateTrafficFlow(activeStream, 'comingFrom', v)}
                        >
                          <SelectTrigger className="flex-1 text-xs">
                            <SelectValue placeholder="Select source..." />
                          </SelectTrigger>
                          <SelectContent>
                            {comingFromOptions.map(o => (
                              <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  {/* RTSP URL (per stream for dual-lens) */}
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground tracking-wide">
                      {isDualLens ? `Stream ${activeStream} RTSP URL` : 'RTSP URL'}
                    </Label>
                    <Input
                      key={`rtsp-stream-${activeStream}`}
                      value={currentStream.rtspUrl}
                      onChange={e => {
                        setSubmitError('');
                        updateStreamField(activeStream, 'rtspUrl', e.target.value);
                      }}
                      placeholder="rtsp://..."
                      className="mt-1.5 font-mono text-xs"
                    />
                  </div>

                  {/* Server Assignment */}
                  <div>
                    <Label className="text-xs uppercase text-muted-foreground tracking-wide flex items-center gap-1">
                      <Server className="w-3 h-3" /> Server Assignment
                    </Label>
                    <Select
                      value={form.serverId?.toString() || 'none'}
                      onValueChange={v => setForm(f => ({ ...f, serverId: v === 'none' ? null : v }))}
                    >
                      <SelectTrigger className="mt-1.5">
                        <SelectValue placeholder="No server assigned" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No server assigned</SelectItem>
                        {servers.map(s => (
                          <SelectItem key={s.id} value={s.id.toString()}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </ScrollArea>

        {/* Footer */}
        {step === 3 && (
          <div className="p-4 border-t border-border space-y-2">
            {submitError && (
              <p className="text-xs text-destructive">{submitError}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button onClick={handleSubmit}>
                Add Camera
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
