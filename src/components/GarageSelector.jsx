import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore, useCustomerGarages, useCurrentCustomer } from '../stores/useAppStore';
import { mapsOpenUrl, safeExternalUrl, customerLocationFields, customerWeatherAddress, hasCustomerLocation } from '../lib/customerUtils';
import {
  countGarageDevices,
  countGarageDevicesByType,
  countGaragesDevices,
  countGaragesDevicesWithTypePrefix,
} from '../lib/deviceCountUtils';
import { customerCanSyncToSheet } from '../lib/customerConfigUtils';
import { defaultLevelSheetConfig } from '../lib/configSheetSchema';
import { syncGarageToSheet, deleteGarageFromSheet } from '../services/ConfigSheetSyncService';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent } from './ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from './ui/dialog';
import Weather from './Weather';
import SetupSyncIndicator from './SetupSyncIndicator';
import { DeviceIcon } from './DeviceIcons';
import {
  Plus, Pencil, Trash2, Building2, MapPin, Home, Sun, Moon,
  ExternalLink, Link2, Globe, ChevronRight, Search,
} from 'lucide-react';

const MotionDiv = motion.div;

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

const US_STATE_TIMEZONES = {
  AL:'America/Chicago',AK:'America/Anchorage',AZ:'America/Phoenix',AR:'America/Chicago',
  CA:'America/Los_Angeles',CO:'America/Denver',CT:'America/New_York',DE:'America/New_York',
  FL:'America/New_York',GA:'America/New_York',HI:'Pacific/Honolulu',ID:'America/Boise',
  IL:'America/Chicago',IN:'America/Indiana/Indianapolis',IA:'America/Chicago',KS:'America/Chicago',
  KY:'America/New_York',LA:'America/Chicago',ME:'America/New_York',MD:'America/New_York',
  MA:'America/New_York',MI:'America/Detroit',MN:'America/Chicago',MS:'America/Chicago',
  MO:'America/Chicago',MT:'America/Denver',NE:'America/Chicago',NV:'America/Los_Angeles',
  NH:'America/New_York',NJ:'America/New_York',NM:'America/Denver',NY:'America/New_York',
  NC:'America/New_York',ND:'America/Chicago',OH:'America/New_York',OK:'America/Chicago',
  OR:'America/Los_Angeles',PA:'America/New_York',RI:'America/New_York',SC:'America/New_York',
  SD:'America/Chicago',TN:'America/Chicago',TX:'America/Chicago',UT:'America/Denver',
  VT:'America/New_York',VA:'America/New_York',WA:'America/Los_Angeles',WV:'America/New_York',
  WI:'America/Chicago',WY:'America/Denver',DC:'America/New_York',
};

function formatUnknownType(type) {
  if (!type) return 'Other';
  const tail = String(type).split('-').slice(1).join(' ') || String(type);
  return tail.replace(/\b\w/g, c => c.toUpperCase());
}

function getLocalTime(stateAbbr) {
  const tz = US_STATE_TIMEZONES[stateAbbr?.toUpperCase()];
  if (!tz) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
    }).format(new Date());
  } catch { return null; }
}

function hasLocationFields(location) {
  return Boolean(
    location?.address || location?.city || location?.state || location?.zip || location?.mapsUrl
  );
}

/** Prefer site fields; otherwise use normalized customer.config location. */
function effectiveLocation(garage, customer) {
  if (hasLocationFields(garage)) return garage;
  return customerLocationFields(customer);
}

function formatAddress(location) {
  return [location?.address, location?.city, location?.state, location?.zip].filter(Boolean).join(', ');
}

function emptySiteForm(customer) {
  return {
    name: '',
    ...customerLocationFields(customer),
  };
}

function siteNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

const LOCATION_KEYS = ['address', 'city', 'state', 'zip', 'mapsUrl'];

function locationFieldsEqual(a, b) {
  return LOCATION_KEYS.every(k => String(a?.[k] || '').trim() === String(b?.[k] || '').trim());
}

export default function GarageSelector() {
  const garages = useCustomerGarages();
  const currentCustomer = useCurrentCustomer();
  const { setGarages, selectGarage, goHome, mode, toggleMode, selectedGarageId, setSelectedGarageId } = useAppStore();

  const [showAddModal, setShowAddModal] = useState(false);
  const [editGarage, setEditGarage] = useState(null);
  const [form, setForm] = useState({ name: '', address: '', city: '', state: '', zip: '', mapsUrl: '' });
  // Location values the form was opened with, and whether they were inherited
  // from the customer (in which case unedited values are not baked onto the site).
  const [locationPrefill, setLocationPrefill] = useState(null);

  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkForm, setLinkForm] = useState({ name: '', url: '', garageId: null, linkId: null });

  const [searchQuery, setSearchQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [savingGarage, setSavingGarage] = useState(false);
  const [deletingGarage, setDeletingGarage] = useState(false);
  const [garageSyncError, setGarageSyncError] = useState('');

  const filteredGarages = useMemo(() => {
    if (!searchQuery.trim()) return garages;
    const q = searchQuery.toLowerCase();
    return garages.filter(g =>
      g.name?.toLowerCase().includes(q) ||
      g.address?.toLowerCase().includes(q) ||
      g.city?.toLowerCase().includes(q) ||
      g.state?.toLowerCase().includes(q) ||
      String(g.zip || '').toLowerCase().includes(q) ||
      (g.quickLinks || []).some(l =>
        l.name?.toLowerCase().includes(q) || l.url?.toLowerCase().includes(q)
      )
    );
  }, [garages, searchQuery]);

  const handleSaveGarage = useCallback(async () => {
    if (!form.name.trim() || savingGarage) return;
    setGarageSyncError('');
    setSavingGarage(true);

    const siteName = form.name.trim();
    const duplicate = garages.some(
      (g) => g.id !== editGarage?.id && siteNameKey(g.name) === siteNameKey(siteName),
    );
    if (duplicate) {
      setGarageSyncError('A site with this name already exists.');
      setSavingGarage(false);
      return;
    }

    // Inherited customer location left untouched is not copied onto the site,
    // so the site keeps following the customer address if it changes later.
    const keepInherited = locationPrefill?.inherited && locationFieldsEqual(form, locationPrefill);
    const locationFields = keepInherited
      ? { address: '', city: '', state: '', zip: '', mapsUrl: '' }
      : { address: form.address, city: form.city, state: form.state, zip: form.zip, mapsUrl: form.mapsUrl };

    let nextGarage;
    let previousGarage = null;

    if (editGarage) {
      // Use the freshest copy of the garage — the store may have been
      // rehydrated (e.g. SetupJson load) while the modal was open.
      const baseGarage = garages.find(g => g.id === editGarage.id) || editGarage;
      previousGarage = {
        internalName: baseGarage.internalName,
        name: baseGarage.name,
      };
      nextGarage = {
        ...baseGarage,
        ...locationFields,
        name: siteName,
        internalName: siteName,
      };
    } else {
      const numericIds = garages.map(g => Number(g.id)).filter(n => Number.isFinite(n));
      const newId = (numericIds.length ? Math.max(...numericIds) : 0) + 1;
      nextGarage = {
        id: newId,
        ...locationFields,
        name: siteName,
        internalName: siteName,
        image: '',
        quickLinks: currentCustomer?.spreadsheetUrl
          ? [{ id: 1, name: currentCustomer.spreadsheetTitle || 'Configuration Sheet', url: currentCustomer.spreadsheetUrl, icon: 'sheets' }]
          : [],
        contacts: [],
        servers: [],
        displayGroups: [],
        sensorGroups: [],
        mdfIdfLocations: [],
        levels: [{
          id: 1,
          name: 'Level 1',
          internalName: 'Level 1',
          totalSpots: 0,
          evSpots: 0,
          handicapSpots: 0,
          bgImage: null,
          devices: [],
          config: { ...defaultLevelSheetConfig(1), maximumOccupancy: 0 },
        }],
      };
    }

    const canSync = customerCanSyncToSheet(currentCustomer);

    if (editGarage) {
      setGarages(prev => prev.map(g => g.id === editGarage.id ? nextGarage : g));
    } else {
      setGarages(prev => [...prev, nextGarage]);
    }

    if (canSync) {
      try {
        await syncGarageToSheet({
          customer: currentCustomer,
          garage: nextGarage,
          previousGarage,
        });
      } catch (err) {
        if (!editGarage) {
          // Roll back only the optimistic add so retry does not create
          // duplicates — without clobbering unrelated concurrent changes.
          setGarages(prev => prev.filter(g => g.id !== nextGarage.id));
          setGarageSyncError(
            err.message || 'Google Sheet sync failed. The site was not added — try again in about a minute.',
          );
        } else {
          setGarageSyncError(
            err.message || 'Site saved locally. Google Sheet sync failed — try again in about a minute.',
          );
        }
        setSavingGarage(false);
        return;
      }
    }

    setShowAddModal(false);
    setGarageSyncError('');
    setSavingGarage(false);
  }, [form, editGarage, garages, setGarages, currentCustomer, savingGarage, locationPrefill]);

  const handleDeleteGarage = useCallback((id) => {
    const g = garages.find(g => g.id === id);
    if (!g) return;
    setConfirmDelete({
      message: `Delete site "${g?.name || ''}" and all its levels and devices?`,
      action: async () => {
        const canSync = customerCanSyncToSheet(currentCustomer);
        if (canSync) {
          await deleteGarageFromSheet({
            customer: currentCustomer,
            garage: g,
            otherGarages: garages.filter(garage => garage.id !== id),
          });
        }
        // Functional update: the store may have changed while the confirm was open.
        setGarages(prev => prev.filter(garage => garage.id !== id));
        if (selectedGarageId === id) setSelectedGarageId(null);
      },
    });
  }, [garages, setGarages, selectedGarageId, setSelectedGarageId, currentCustomer]);

  const handleSaveLink = useCallback(() => {
    if (!linkForm.name.trim() || !linkForm.url.trim() || !linkForm.garageId) return;
    const normalizedUrl = safeExternalUrl(linkForm.url, { allowHttp: true });
    if (!normalizedUrl) return;
    setGarages(garages.map(g => {
      if (g.id !== linkForm.garageId) return g;
      const links = g.quickLinks || [];
      if (linkForm.linkId) {
        return { ...g, quickLinks: links.map(l => l.id === linkForm.linkId ? { ...l, name: linkForm.name, url: normalizedUrl } : l) };
      }
      const numericLinkIds = links.map(l => Number(l.id)).filter(n => Number.isFinite(n));
      const newId = (numericLinkIds.length ? Math.max(...numericLinkIds) : 0) + 1;
      return { ...g, quickLinks: [...links, { id: newId, name: linkForm.name, url: normalizedUrl, icon: 'link' }] };
    }));
    setShowLinkModal(false);
    setLinkForm({ name: '', url: '', garageId: null, linkId: null });
  }, [linkForm, garages, setGarages]);

  const handleDeleteLink = useCallback((garageId, linkId) => {
    setConfirmDelete({ message: 'Delete this quick link?', action: () => {
      // Functional update: the store may have changed while the confirm was open.
      setGarages(prev => prev.map(g => {
        if (g.id !== garageId) return g;
        return { ...g, quickLinks: (g.quickLinks || []).filter(l => l.id !== linkId) };
      }));
    }});
  }, [setGarages]);

  const totalLevels = useMemo(() => garages.reduce((sum, g) => sum + (g.levels?.length || 0), 0), [garages]);
  const totalDevices = useMemo(() => countGaragesDevices(garages), [garages]);
  const totalSpots = useMemo(() => garages.reduce((sum, g) => sum + (g.levels ?? []).reduce((s, l) => s + (l.totalSpots || 0), 0), 0), [garages]);
  const totalCameras = useMemo(() => countGaragesDevicesWithTypePrefix(garages, 'cam-'), [garages]);
  const totalSigns = useMemo(() => countGaragesDevicesWithTypePrefix(garages, 'sign-'), [garages]);
  const totalSensors = useMemo(() => countGaragesDevicesWithTypePrefix(garages, 'sensor-'), [garages]);

  const customerAddress = useMemo(() => customerWeatherAddress(currentCustomer), [currentCustomer]);
  const customerWeatherAddr = customerAddress;
  const customerState = customerLocationFields(currentCustomer).state;

  // Re-render every 30s so the local-time clock keeps ticking.
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const customerLocalTime = useMemo(
    () => getLocalTime(customerState || garages[0]?.state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customerState, garages, clockTick],
  );

  const closeAddModal = useCallback(() => {
    setShowAddModal(false);
    setGarageSyncError('');
  }, []);

  const openAddSiteModal = useCallback(() => {
    setForm(emptySiteForm(currentCustomer));
    setLocationPrefill({ inherited: true, ...customerLocationFields(currentCustomer) });
    setEditGarage(null);
    setGarageSyncError('');
    setShowAddModal(true);
  }, [currentCustomer]);

  return (
    <div className="sites-page min-h-screen flex overflow-x-hidden overscroll-x-none bg-[#1d242c] text-white">
      {/*
        Contacts sidebar intentionally omitted on the multi-site list view.
        Contacts are scoped per-garage and are shown after a site is selected.
      */}

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
            <div className="flex items-center gap-3">
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-[19px] font-extrabold leading-tight tracking-[0.2px]">Sites</h1>
                  {currentCustomer && (
                    <span className="rounded border border-[#495057] bg-[#282e35] px-2.5 py-1 text-[10px] font-semibold text-[#adb5bd]">
                      {currentCustomer.friendlyName}
                    </span>
                  )}
                </div>
                {currentCustomer && (
                  <div className="min-w-0">
                    {customerAddress && (
                      <p className="mt-0.5 text-[10px] text-[#6c757d] leading-tight truncate max-w-[320px] flex items-center gap-1">
                        <MapPin className="w-2.5 h-2.5 shrink-0" />
                        {customerAddress}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <SetupSyncIndicator />
            {customerWeatherAddr && (
              <Weather address={customerWeatherAddr} />
            )}
            {customerLocalTime && (
              <span className="text-[11px] text-[#949494]">{customerLocalTime}</span>
            )}

            <button
              onClick={toggleMode}
              className="p-1.5 rounded-md text-[#949494] hover:bg-[#282e35] hover:text-white cursor-pointer transition-colors"
              title={mode === 'dark' ? 'Light mode' : 'Dark mode'}
              aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {mode === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-7 py-6">
          {garageSyncError && !showAddModal && (
            <div className="mb-4 max-w-4xl mx-auto flex items-start gap-3 p-3 rounded-xl border border-destructive/30 bg-destructive/5">
              <p className="flex-1 text-sm text-destructive">{garageSyncError}</p>
              <button
                type="button"
                onClick={() => setGarageSyncError('')}
                className="text-xs text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {garages.length > 0 && (
            <section className="mb-5 flex flex-wrap items-center gap-y-2 border-y border-[#3a424b] bg-[#20272f]/45 px-1 py-2" aria-label="Site totals">
              {[
                ['Sites', garages.length, '#49b6d6'],
                ['Levels', totalLevels, '#adb5bd'],
                ['Spots', totalSpots, '#348fe2'],
                ['Devices', totalDevices, '#ffffff'],
                ['Cameras', totalCameras, '#49b6d6'],
                ['Signs', totalSigns, '#f59c1a'],
                ['Sensors', totalSensors, '#00acac'],
              ].map(([label, value, color], index) => (
                <div key={label} className={`flex min-w-[112px] items-center gap-2.5 px-4 py-1.5 ${index > 0 ? 'border-l border-[#3a424b]' : ''}`}>
                  <span className="h-6 w-[3px] rounded-full" style={{ backgroundColor: color }} />
                  <div>
                    <div className="text-[20px] font-bold leading-none tabular-nums text-white">{value}</div>
                    <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-[#949494]">{label}</div>
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* Search + Add */}
          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-[5px] border border-[#3a424b] bg-[#20272f] px-4 py-3">
            <span className="whitespace-nowrap text-[12px] font-semibold uppercase tracking-[0.1em] text-[#949494]">Filter Sites</span>
            <div className="relative w-[280px]">
              <Search className="absolute left-2.5 top-1/2 h-[13px] w-[13px] -translate-y-1/2 text-[#949494]" />
              <Input
                placeholder="…by site name or address"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="h-[30px] rounded-[5px] border-[#495057] bg-[#151c23] pl-7 text-[12px] text-white placeholder:text-[#6c757d] focus-visible:ring-1"
                aria-label="Search sites"
              />
            </div>
            <Button onClick={openAddSiteModal} className="ml-auto h-[30px] rounded-[5px] bg-white px-4 text-[11px] font-bold text-[#151c23] hover:bg-[#e9ecef]">
              <Plus className="h-3 w-3" /> Add Site
            </Button>
          </div>

          {garages.length === 0 && hasCustomerLocation(currentCustomer) && (
            <div className="mb-6 max-w-2xl mx-auto">
              <Card className="border-primary/20">
                <CardContent className="p-5">
                  <div className="flex items-start gap-3">
                    <MapPin className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Customer location</p>
                      <p className="text-xs text-muted-foreground mt-1">{customerAddress}</p>
                      {customerWeatherAddr && (
                        <div className="mt-2">
                          <Weather address={customerWeatherAddr} />
                        </div>
                      )}
                    </div>
                  </div>
                  {mapsOpenUrl(customerLocationFields(currentCustomer).mapsUrl, customerAddress) && (
                    <a
                      href={mapsOpenUrl(customerLocationFields(currentCustomer).mapsUrl, customerAddress)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                    >
                      Open in Google Maps
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {garages.length > 0 && filteredGarages.length === 0 && (
            <div className="max-w-md mx-auto text-center py-12 mb-6">
              <Search className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
              <h2 className="text-base font-semibold mb-1">No matching sites</h2>
              <p className="text-sm text-muted-foreground mb-4">
                No sites match &ldquo;{searchQuery}&rdquo;.
              </p>
              <Button variant="outline" size="sm" onClick={() => setSearchQuery('')}>
                Clear search
              </Button>
            </div>
          )}

          {garages.length === 0 && (
            <div className="max-w-md mx-auto text-center py-12 mb-6">
              <Building2 className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
              <h2 className="text-base font-semibold mb-1">No sites yet</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Add a site or import a configuration to get started.
              </p>
              <Button onClick={openAddSiteModal}>
                <Plus className="w-4 h-4" /> Add Site
              </Button>
            </div>
          )}

          {/* Garage Cards Grid */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            <AnimatePresence>
              {filteredGarages.map((garage, i) => {
                const location = effectiveLocation(garage, currentCustomer);
                const fullAddress = formatAddress(location);
                const levels = garage.levels ?? [];
                const deviceCount = countGarageDevices(garage);
                const spotCount = levels.reduce((s, l) => s + (l.totalSpots || 0), 0);
                const typeCounts = countGarageDevicesByType(garage);

                return (
                  <MotionDiv
                    key={garage.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ delay: i * 0.05, duration: 0.3 }}
                  >
                    <Card className="group cursor-pointer overflow-hidden rounded-xl border-[#3a424b] bg-[#282e35] text-white shadow-[0_.125rem_.25rem_rgba(0,0,0,.3)] transition-all duration-200 hover:border-[#495057] hover:shadow-[0_.5rem_1rem_rgba(0,0,0,.35)]"
                      onClick={() => selectGarage(garage.id)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <h3 className="text-[15px] font-bold transition-colors group-hover:text-[#49b6d6]">{garage.name}</h3>
                            {fullAddress && (
                              <p className="mt-1 flex items-center gap-1 text-[10.5px] text-[#6c757d]">
                                <MapPin className="w-3 h-3" />
                                {fullAddress}
                              </p>
                            )}
                            {/* Skip card weather when it would duplicate the header weather. */}
                            {fullAddress && fullAddress !== customerWeatherAddr && (
                              <div className="mt-1.5">
                                <Weather address={fullAddress} />
                              </div>
                            )}
                          </div>
                          <div className="flex gap-1 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => {
                                const inherited = !hasLocationFields(garage);
                                const loc = effectiveLocation(garage, currentCustomer);
                                const locFields = {
                                  address: loc.address || '',
                                  city: loc.city || '',
                                  state: loc.state || '',
                                  zip: loc.zip || '',
                                  mapsUrl: loc.mapsUrl || '',
                                };
                                setForm({ name: garage.name, ...locFields });
                                setLocationPrefill({ inherited, ...locFields });
                                setEditGarage(garage);
                                setGarageSyncError('');
                                setShowAddModal(true);
                              }}
                              className="p-1.5 rounded-md text-[#949494] hover:bg-[#1d242c] hover:text-white cursor-pointer"
                              aria-label={`Edit ${garage.name}`}
                              title="Edit site"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteGarage(garage.id)}
                              className="p-1.5 rounded-md hover:bg-[#ff5b57]/10 text-[#ff5b57] cursor-pointer"
                              aria-label={`Delete ${garage.name}`}
                              title="Delete site"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Google Maps link */}
                        {(() => {
                          const openHref = mapsOpenUrl(location.mapsUrl, fullAddress);
                          if (!openHref) return null;
                          return (
                            <a
                              href={openHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="mb-3 flex items-center justify-between gap-2 rounded-[5px] border border-[#3a424b] bg-[#1d242c] px-3 py-2 text-[10.5px] text-[#adb5bd] transition-colors hover:border-[#49b6d6]/50 hover:text-white"
                              title="Open in Google Maps"
                            >
                              <span className="flex min-w-0 items-center gap-2"><MapPin className="h-3.5 w-3.5 shrink-0 text-[#49b6d6]" /><span className="truncate">{fullAddress || location.mapsUrl}</span></span>
                              <span className="flex shrink-0 items-center gap-1 font-semibold text-[#49b6d6]">Maps <ExternalLink className="h-3 w-3" /></span>
                            </a>
                          );
                        })()}

                        {/* Stats */}
                        <div className="mb-3 grid grid-cols-3 overflow-hidden rounded-[5px] border border-[#3a424b] bg-[#20272f]">
                          {[
                            { label: 'Levels', value: levels.length },
                            { label: 'Spots', value: spotCount },
                            { label: 'Devices', value: deviceCount },
                          ].map(({ label, value }) => (
                            <div key={label} className="flex items-center justify-center gap-2 border-r border-[#3a424b] p-2 last:border-r-0">
                              <span className="text-[14px] font-bold">{value}</span>
                              <span className="text-[9px] uppercase tracking-wide text-[#949494]">{label}</span>
                            </div>
                          ))}
                        </div>

                        {/* Device Breakdown */}
                        {deviceCount > 0 && (
                          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#949494]">
                            {Object.entries(typeCounts).map(([type, count]) => (
                              <span key={type} className="flex items-center gap-1">
                                <DeviceIcon type={type} className="w-3 h-3" style={{ color: DEVICE_TYPE_COLORS[type] || '#6b7280' }} />
                                {count} {DEVICE_TYPE_LABELS[type] || formatUnknownType(type)}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Quick Links */}
                        {(garage.quickLinks?.length > 0) && (
                          <div className="space-y-1 mb-3" onClick={e => e.stopPropagation()}>
                            {garage.quickLinks.map(link => {
                              const linkHref = safeExternalUrl(link.url, { allowHttp: true });
                              return (
                              <div key={link.id} className="flex items-center gap-2 group/link">
                                {linkHref ? (
                                  <a
                                    href={linkHref}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex flex-1 items-center gap-1.5 truncate text-[10.5px] text-[#49b6d6] hover:underline"
                                  >
                                    {link.icon === 'sheets' ? (
                                      <Globe className="w-3 h-3 shrink-0" />
                                    ) : (
                                      <Link2 className="w-3 h-3 shrink-0" />
                                    )}
                                    {link.name}
                                    <ExternalLink className="w-2.5 h-2.5 opacity-50" />
                                  </a>
                                ) : (
                                  <span
                                    className="flex flex-1 items-center gap-1.5 truncate text-[10.5px] text-[#ff5b57]"
                                    title={link.url ? 'Invalid URL — edit or delete this link' : 'Missing URL'}
                                  >
                                    <Link2 className="w-3 h-3 shrink-0" />
                                    {link.name}
                                    <span className="opacity-70">(invalid URL)</span>
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setLinkForm({ name: link.name, url: link.url, garageId: garage.id, linkId: link.id });
                                    setShowLinkModal(true);
                                  }}
                                  className="opacity-0 group-hover/link:opacity-100 focus:opacity-100 p-0.5 cursor-pointer"
                                  aria-label={`Edit link ${link.name}`}
                                >
                                  <Pencil className="w-2.5 h-2.5 text-muted-foreground" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteLink(garage.id, link.id)}
                                  className="opacity-0 group-hover/link:opacity-100 focus:opacity-100 p-0.5 cursor-pointer"
                                  aria-label={`Delete link ${link.name}`}
                                >
                                  <Trash2 className="w-2.5 h-2.5 text-destructive" />
                                </button>
                              </div>
                            );
                            })}
                          </div>
                        )}

                        {/* Add Link + Open */}
                        <div className="flex items-center justify-between border-t border-[#3a424b] pt-2" onClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => {
                              setLinkForm({ name: '', url: '', garageId: garage.id, linkId: null });
                              setShowLinkModal(true);
                            }}
                            className="flex cursor-pointer items-center gap-1 text-[10.5px] text-[#6c757d] hover:text-[#adb5bd]"
                          >
                            <Plus className="w-3 h-3" /> Add link
                          </button>
                          <button
                            type="button"
                            onClick={() => selectGarage(garage.id)}
                            className="flex cursor-pointer items-center gap-1 text-[11px] font-bold text-white transition-all hover:gap-2"
                          >
                            Open <ChevronRight className="w-3 h-3" />
                          </button>
                        </div>
                      </CardContent>
                    </Card>
                  </MotionDiv>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Add/Edit Garage Modal */}
      <Dialog open={showAddModal} onOpenChange={(open) => {
        if (savingGarage) return;
        if (open) setShowAddModal(true);
        else closeAddModal();
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editGarage ? 'Edit Site' : 'Add New Site'}</DialogTitle>
            <DialogDescription>Enter the site details below.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Site Name *</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Main Parking Garage" className="mt-1.5" />
            </div>
            <div>
              <Label>Address</Label>
              <Input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="123 Main St" className="mt-1.5" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>City</Label>
                <Input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder="City" className="mt-1.5" />
              </div>
              <div>
                <Label>State</Label>
                <Input
                  value={form.state}
                  onChange={e => setForm(f => ({ ...f, state: e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2) }))}
                  placeholder="PA"
                  className="mt-1.5"
                  maxLength={2}
                />
              </div>
              <div>
                <Label>ZIP</Label>
                <Input value={form.zip} onChange={e => setForm(f => ({ ...f, zip: e.target.value }))} placeholder="18102" className="mt-1.5" />
              </div>
            </div>
            <div>
              <Label>Google Maps URL <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                value={form.mapsUrl}
                onChange={e => setForm(f => ({ ...f, mapsUrl: e.target.value }))}
                placeholder="https://maps.google.com/?q=..."
                className="mt-1.5"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Paste a Google Maps share link, or leave blank to use the address above.</p>
            </div>
            {garageSyncError && (
              <p className="text-sm text-destructive">{garageSyncError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeAddModal} disabled={savingGarage}>Cancel</Button>
            <Button onClick={handleSaveGarage} disabled={!form.name.trim() || savingGarage}>
              {savingGarage ? 'Saving...' : editGarage ? 'Save Changes' : 'Add Site'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick Link Modal */}
      <Dialog open={showLinkModal} onOpenChange={setShowLinkModal}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{linkForm.linkId ? 'Edit Link' : 'Add Quick Link'}</DialogTitle>
            <DialogDescription>
              Quick links are saved with the site setup (local / SetupJson), not a Google Sheet tab.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input value={linkForm.name} onChange={e => setLinkForm(f => ({ ...f, name: e.target.value }))} placeholder="Link name" className="mt-1.5" />
            </div>
            <div>
              <Label>URL</Label>
              <Input
                value={linkForm.url}
                onChange={e => setLinkForm(f => ({ ...f, url: e.target.value }))}
                placeholder="https://..."
                className="mt-1.5"
              />
              {linkForm.url.trim() && !safeExternalUrl(linkForm.url, { allowHttp: true }) && (
                <p className="text-sm text-destructive mt-1">
                  Enter a valid http(s) URL (e.g. https://example.com).
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLinkModal(false)}>Cancel</Button>
            <Button
              onClick={handleSaveLink}
              disabled={!linkForm.name.trim() || !linkForm.url.trim() || !safeExternalUrl(linkForm.url, { allowHttp: true })}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => {
        if (!open && !deletingGarage) setConfirmDelete(null);
      }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
            <DialogDescription>{confirmDelete?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deletingGarage}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deletingGarage}
              onClick={async () => {
                setDeletingGarage(true);
                try {
                  await confirmDelete?.action();
                  setConfirmDelete(null);
                } catch (err) {
                  setGarageSyncError(err.message || 'Failed to delete site from Google Sheet.');
                  setConfirmDelete(null);
                } finally {
                  setDeletingGarage(false);
                }
              }}
            >
              {deletingGarage ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
