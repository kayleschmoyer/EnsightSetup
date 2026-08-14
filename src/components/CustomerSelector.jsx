import React, { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'motion/react';

const MotionDiv = motion.div;
import { useAppStore } from '../stores/useAppStore';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent } from './ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from './ui/dialog';
import {
  signInWithGoogle, signOut, isSignedIn, verifySharedFolderAccess, listAllConfigFilesInFolder,
  subscribeGoogleAuth, hadGoogleSession, renameDriveFile, publishGoogleAuthState,
} from '../services/GoogleDriveService';
import {
  assertConfigSheetNameAvailable,
  createCustomerConfigSheet,
  customerSheetQuickLink,
  sheetHasConfigData,
  syncCustomerToSheet,
} from '../services/ConfigSheetSyncService';
import { openConfigFromDriveFile } from '../services/OpenConfigFromDriveService';
import { customerCanSyncToSheet } from '../lib/customerConfigUtils';
import {
  mergeConfigFilesIntoCatalog,
  buildCustomerListRows,
  configFileMetaFromAppProperties,
} from '../lib/driveConfigCatalog';
import { configSheetTitle, buildInitialCustomerGarage, defaultCustomerConfig } from '../lib/configSheetSchema';
import { countGaragesDevices } from '../lib/deviceCountUtils';
import {
  customerIdFromFriendlyName, customerCodeFromId, mapsOpenUrl,
  normalizeCustomerConfig, customerLocationFields, customerWeatherAddress,
  customerConfigPatch,
} from '../lib/customerUtils';
import Weather from './Weather';
import CustomerSupportDialog from './CustomerSupportDialog';
import AppSettingsDialog from './AppSettingsDialog';
import ReportIssueDialog from './ReportIssueDialog';
import { cn } from '../lib/utils';
import {
  Plus, Users, ChevronRight, ChevronDown,
  Search, Sun, Moon, Loader2, AlertCircle, RefreshCw,
  Settings,
} from 'lucide-react';

const CustomerMapDialog = lazy(() => import('./CustomerMapDialog'));

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

function getLocalTime(stateAbbr) {
  const tz = US_STATE_TIMEZONES[stateAbbr?.toUpperCase()];
  if (!tz) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
  } catch { return null; }
}

const EMPTY_CUSTOMER_FORM = {
  friendlyName: '', address: '', city: '', state: '', zip: '', mapsUrl: '',
};

function CustomerFormFields({ form, setForm }) {
  return (
    <div className="space-y-3">
      <div>
        <Label>Friendly Name *</Label>
        <Input
          value={form.friendlyName}
          onChange={(e) => setForm((f) => ({ ...f, friendlyName: e.target.value }))}
          placeholder="Stanford Health Care"
          className="mt-1.5"
        />
      </div>
      <div>
        <Label>Address</Label>
        <Input
          value={form.address}
          onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
          placeholder="123 Main St"
          className="mt-1.5"
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>City</Label>
          <Input
            value={form.city}
            onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
            placeholder="City"
            className="mt-1.5"
          />
        </div>
        <div>
          <Label>State</Label>
          <Input
            value={form.state}
            onChange={(e) => setForm((f) => ({ ...f, state: e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2) }))}
            placeholder="PA"
            className="mt-1.5"
            maxLength={2}
          />
        </div>
        <div>
          <Label>ZIP</Label>
          <Input
            value={form.zip}
            onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
            placeholder="18102"
            className="mt-1.5"
          />
        </div>
      </div>
      <div>
        <Label>Google Maps URL <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Input
          value={form.mapsUrl}
          onChange={(e) => setForm((f) => ({ ...f, mapsUrl: e.target.value }))}
          placeholder="https://maps.google.com/?q=..."
          className="mt-1.5"
        />
        <p className="text-[10px] text-muted-foreground mt-1">Paste a Google Maps share link, or leave blank to use the address above.</p>
      </div>
    </div>
  );
}

export default function CustomerSelector() {
  const {
    customers, addCustomer, updateCustomer, removeCustomer,
    selectCustomer, mode, toggleMode, localSaveError,
  } = useAppStore();

  const [authenticated, setAuthenticated] = useState(isSignedIn());
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [driveAccessDenied, setDriveAccessDenied] = useState(false);
  const [, setSessionExpired] = useState(false);

  const [catalogRows, setCatalogRows] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogFetched, setCatalogFetched] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editSyncError, setEditSyncError] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [form, setForm] = useState(EMPTY_CUSTOMER_FORM);
  const [editCustomer, setEditCustomer] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmOpenRow, setConfirmOpenRow] = useState(null);
  /** 'open' = first open from Drive; 'reload' = replace local from Drive */
  const [confirmOpenMode, setConfirmOpenMode] = useState('open');
  const [openingConfig, setOpeningConfig] = useState(false);
  const [openConfigError, setOpenConfigError] = useState('');
  const openConfigGenerationRef = useRef(0);
  const openAbortRef = useRef(null);
  const catalogFetchGenRef = useRef(0);
  const [expandedCustomerIds, setExpandedCustomerIds] = useState(() => new Set());
  const [showMap, setShowMap] = useState(false);
  const [supportDialogCustomer, setSupportDialogCustomer] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showReportIssue, setShowReportIssue] = useState(false);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [addCustomerError, setAddCustomerError] = useState('');

  const toggleExpanded = useCallback((customerId) => {
    setExpandedCustomerIds((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  }, []);

  const fetchCatalog = useCallback(async () => {
    if (!isSignedIn()) {
      setCatalogError('Sign in with Google to load site configs from Drive.');
      return;
    }
    const generation = ++catalogFetchGenRef.current;
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const { files } = await listAllConfigFilesInFolder();
      if (generation !== catalogFetchGenRef.current) return;
      setCatalogRows(mergeConfigFilesIntoCatalog(files));
      setCatalogFetched(true);
    } catch (err) {
      if (generation !== catalogFetchGenRef.current) return;
      setCatalogError(err.message || 'Failed to load site configs from Drive.');
      if (err.code === 'DRIVE_FORBIDDEN') {
        setDriveAccessDenied(true);
      }
    } finally {
      if (generation === catalogFetchGenRef.current) {
        setCatalogLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setAuthenticated(isSignedIn());
  }, []);

  // Keep page banners in sync when the global session popup (or another view) signs in.
  // Only change Drive-denied state when meta explicitly sets driveAccessDenied —
  // silent token refresh notifies with empty meta and must not clear the banner.
  useEffect(() => {
    return subscribeGoogleAuth((signedIn, meta = {}) => {
      setAuthenticated(signedIn);
      if (signedIn) {
        setSessionExpired(false);
        if (meta.driveAccessDenied === true) {
          setDriveAccessDenied(true);
          setAuthError(meta.error || 'Google Drive access to the configuration folder was denied.');
        } else if (meta.driveAccessDenied === false) {
          setDriveAccessDenied(false);
          setAuthError('');
        }
      } else if (hadGoogleSession()) {
        setSessionExpired(true);
        setAuthError('Your Google session expired. Sign in again to sync site configs.');
      }
    });
  }, []);

  useEffect(() => {
    if (!authenticated || driveAccessDenied) return undefined;
    const checkSession = () => {
      if (!isSignedIn()) {
        setAuthenticated(false);
        setSessionExpired(true);
        setAuthError('Your Google session expired. Sign in again to sync site configs.');
      }
    };
    checkSession();
    const intervalId = setInterval(checkSession, 60_000);
    return () => clearInterval(intervalId);
  }, [authenticated, driveAccessDenied]);

  useEffect(() => {
    if (!authenticated || driveAccessDenied) return;
    fetchCatalog();
  }, [authenticated, driveAccessDenied, fetchCatalog]);

  const handleSignIn = useCallback(async (forceConsent = false) => {
    setAuthError('');
    setDriveAccessDenied(false);
    setAuthLoading(true);
    try {
      await signInWithGoogle({ prompt: forceConsent ? 'consent' : 'select_account' });
      const hasDriveAccess = await verifySharedFolderAccess();
      if (!hasDriveAccess) {
        const message =
          'Signed in, but Google Drive access to the configuration folder was denied. ' +
          'Click "Grant Drive Access" below to approve Drive permissions, or ask an administrator ' +
          'to share the folder with your account.';
        publishGoogleAuthState(true, { driveAccessDenied: true, error: message });
        setDriveAccessDenied(true);
        setAuthError(message);
        setAuthenticated(true);
        return;
      }
      publishGoogleAuthState(true, { driveAccessDenied: false });
      setDriveAccessDenied(false);
      setSessionExpired(false);
      setAuthError('');
      setAuthenticated(true);
    } catch (err) {
      setAuthError(err.message || 'Sign-in failed');
      setAuthenticated(false);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const handleSignOut = useCallback(() => {
    signOut();
    setAuthenticated(false);
    setDriveAccessDenied(false);
    setSessionExpired(false);
    setAuthError('');
    setCatalogRows([]);
    setCatalogFetched(false);
    setCatalogError('');
  }, []);

  const listRows = useMemo(
    () => buildCustomerListRows(customers, catalogRows),
    [customers, catalogRows],
  );

  const filteredRows = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return listRows.filter((row) => {
      const matchesSearch = !q.trim()
        || row.displayName?.toLowerCase().includes(q)
        || row.key?.toLowerCase().includes(q)
        || row.customer?.friendlyName?.toLowerCase().includes(q)
        || row.customer?.customerId?.toLowerCase().includes(q)
        || row.customer?.code?.toLowerCase().includes(q)
        || row.customer?.config?.city?.toLowerCase().includes(q)
        || row.customer?.config?.address?.toLowerCase().includes(q);
      if (!matchesSearch) return false;
      if (statusFilter === 'opened') return Boolean(row.customer);
      if (statusFilter === 'sheets') return !row.customer && row.isNativeSheet;
      if (statusFilter === 'excel') return !row.customer && !row.isNativeSheet;
      if (statusFilter === 'local') return row.isLocalOnly;
      return true;
    });
  }, [listRows, searchQuery, statusFilter]);

  const handleCancelOpenConfig = useCallback(() => {
    openConfigGenerationRef.current += 1;
    try {
      openAbortRef.current?.abort();
    } catch {
      // ignore
    }
    openAbortRef.current = null;
    setOpeningConfig(false);
    setConfirmOpenRow(null);
    setConfirmOpenMode('open');
    setOpenConfigError('');
  }, []);

  /** Open / reload a Drive catalog row. Pass `row` to start immediately (no confirm click). */
  const openFromDrive = useCallback(async (row) => {
    if (!row?.catalogRow?.file || openingConfig) return;
    const generation = ++openConfigGenerationRef.current;
    try {
      openAbortRef.current?.abort();
    } catch {
      // ignore
    }
    const controller = new AbortController();
    openAbortRef.current = controller;
    setConfirmOpenRow(row);
    setOpeningConfig(true);
    setOpenConfigError('');
    try {
      const catalogRow = row.catalogRow;
      // Default: open from the catalog file (native Sheet or lone xlsx).
      let sourceFile = catalogRow.file;
      let existingSpreadsheetId = row.customer?.spreadsheetId ?? null;
      if (catalogRow.isNativeSheet && catalogRow.sourceXlsxFile) {
        // A hung Excel open can leave an empty Sheet that the catalog prefers.
        // Re-seed from the companion .xlsx only when the Sheet has no config
        // data yet — a healthy Sheet (with newer team edits) is never overwritten.
        const seeded = await sheetHasConfigData(catalogRow.file.id);
        if (generation !== openConfigGenerationRef.current) return;
        if (!seeded) {
          sourceFile = catalogRow.sourceXlsxFile;
          existingSpreadsheetId = catalogRow.file.id;
        }
      }
      await openConfigFromDriveFile({
        sourceFile,
        customers: useAppStore.getState().customers,
        store: {
          addCustomer: useAppStore.getState().addCustomer,
          updateCustomer: useAppStore.getState().updateCustomer,
          selectCustomer: useAppStore.getState().selectCustomer,
          setHydration: useAppStore.getState().setHydration,
        },
        friendlyName: row.displayName,
        mode: row.customer ? 'replace' : 'new',
        existingSpreadsheetId,
        existingCustomerId: row.customer?.id ?? null,
        signal: controller.signal,
      });
      if (generation !== openConfigGenerationRef.current) return;
      setConfirmOpenRow(null);
      setConfirmOpenMode('open');
      await fetchCatalog();
    } catch (err) {
      // Cancel bumps the generation, so aborted opens never reach here.
      if (generation !== openConfigGenerationRef.current) return;
      setOpenConfigError(err.message || 'Failed to open configuration.');
    } finally {
      if (generation === openConfigGenerationRef.current) {
        setOpeningConfig(false);
        openAbortRef.current = null;
      }
    }
  }, [openingConfig, fetchCatalog]);

  const handleRowActivate = useCallback((row) => {
    // Already opened locally — go straight in (SetupJson hydrate runs in selectCustomer).
    if (row.customer) {
      selectCustomer(row.customer.id);
      return;
    }
    if (!row.catalogRow?.file) return;
    if (!isSignedIn()) {
      setSessionExpired(true);
      setAuthError('Sign in with Google to open customers from Drive.');
      return;
    }
    // Existing Drive site: open immediately — no "Open shared config?" confirm.
    setConfirmOpenMode('open');
    void openFromDrive(row);
  }, [selectCustomer, openFromDrive]);

  const handleAskReloadFromDrive = useCallback((row) => {
    if (!row?.catalogRow?.file || !row.customer) return;
    if (!isSignedIn()) {
      setSessionExpired(true);
      setAuthError('Sign in with Google to reload from Drive.');
      return;
    }
    setOpenConfigError('');
    setConfirmOpenMode('reload');
    setConfirmOpenRow(row);
  }, []);

  const handleConfirmOpenOnly = useCallback(() => {
    if (!confirmOpenRow?.customer) return;
    setConfirmOpenRow(null);
    setOpenConfigError('');
    selectCustomer(confirmOpenRow.customer.id);
  }, [confirmOpenRow, selectCustomer]);

  const handleConfirmReloadFromDrive = useCallback(() => {
    if (!confirmOpenRow) return;
    void openFromDrive(confirmOpenRow);
  }, [confirmOpenRow, openFromDrive]);

  const handleAddCustomer = useCallback(async () => {
    const name = form.friendlyName.trim();
    if (!name || addingCustomer) return;

    if (!isSignedIn()) {
      setAddCustomerError('Sign in with Google to create a configuration sheet.');
      return;
    }

    const sheetTitle = configSheetTitle(name);
    const duplicateLocal = customers.some(
      (c) => configSheetTitle(c.friendlyName).toLowerCase() === sheetTitle.toLowerCase(),
    );
    if (duplicateLocal) {
      setAddCustomerError(
        `A customer named "${name}" already exists. Choose a different friendly name.`,
      );
      return;
    }

    setAddingCustomer(true);
    setAddCustomerError('');
    try {
      const initialGarage = buildInitialCustomerGarage(name, {
        address: form.address.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        zip: form.zip.trim(),
        mapsUrl: form.mapsUrl.trim(),
      });
      const existingIds = customers.map((c) => c.customerId);
      const customerId = customerIdFromFriendlyName(name, existingIds);
      const customerConfig = {
        ...defaultCustomerConfig(),
        address: form.address.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        zip: form.zip.trim(),
        mapsUrl: form.mapsUrl.trim(),
        support: { ...defaultCustomerConfig().support },
      };
      const sheet = await createCustomerConfigSheet({
        friendlyName: name,
        customerId,
        code: customerCodeFromId(customerId),
        config: customerConfig,
        garage: initialGarage,
        levels: initialGarage.levels,
      });
      const sheetLink = customerSheetQuickLink(sheet.spreadsheetTitle, sheet.spreadsheetUrl);
      addCustomer({
        customerId,
        code: customerCodeFromId(customerId),
        friendlyName: name,
        config: customerConfig,
        garages: [{ ...initialGarage, quickLinks: [sheetLink] }],
        spreadsheetId: sheet.spreadsheetId,
        spreadsheetUrl: sheet.spreadsheetUrl,
        spreadsheetTitle: sheet.spreadsheetTitle,
      });
      setForm(EMPTY_CUSTOMER_FORM);
      setShowAddModal(false);
      await fetchCatalog();
    } catch (err) {
      setAddCustomerError(err.message || 'Failed to create configuration sheet.');
    } finally {
      setAddingCustomer(false);
    }
  }, [form, customers, addCustomer, addingCustomer, fetchCatalog]);

  const openEditCustomer = useCallback((customer) => {
    setEditCustomer(customer);
    setEditSyncError('');
    const location = customerLocationFields(customer);
    setForm({
      friendlyName: customer.friendlyName || '',
      ...location,
    });
    setShowEditModal(true);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editCustomer || !form.friendlyName.trim() || savingEdit) return;
    setEditSyncError('');
    const updates = {
      friendlyName: form.friendlyName.trim(),
      ...customerConfigPatch(editCustomer, {
        address: form.address.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        zip: form.zip.trim(),
        mapsUrl: form.mapsUrl.trim(),
      }),
    };
    const newSheetTitle = configSheetTitle(updates.friendlyName);
    const nameChanged = newSheetTitle !== configSheetTitle(editCustomer.friendlyName || '');
    if (nameChanged) {
      const duplicateLocal = customers.some(
        (c) => c.id !== editCustomer.id
          && configSheetTitle(c.friendlyName).toLowerCase() === newSheetTitle.toLowerCase(),
      );
      if (duplicateLocal) {
        setEditSyncError(
          `A customer named "${updates.friendlyName}" already exists. Choose a different friendly name.`,
        );
        return;
      }
    }
    const canSync = customerCanSyncToSheet(editCustomer);
    // Rename the companion xlsx too, so the catalog keeps matching the Sheet
    // and the xlsx to one row after a rename (they merge by file-name stem).
    const hasCompanionXlsx = Boolean(
      editCustomer.sourceFileId && editCustomer.sourceFileId !== editCustomer.spreadsheetId,
    );
    const xlsxExt = (editCustomer.sourceFileName || '').match(/\.[A-Za-z0-9]+$/)?.[0] || '.xlsx';
    const newSourceFileName = `${newSheetTitle}${xlsxExt}`;

    const oldSheetTitle = configSheetTitle(editCustomer.friendlyName || '');
    const localNamePatch = {
      friendlyName: updates.friendlyName,
      spreadsheetTitle: newSheetTitle,
      ...(hasCompanionXlsx ? { sourceFileName: newSourceFileName } : {}),
    };

    setSavingEdit(true);
    let renamedOnDrive = false;
    try {
      if (canSync) {
        if (nameChanged && editCustomer.spreadsheetId) {
          // Drive allows duplicate file names; make sure the new name is free.
          // Exclude this customer's own files so a retry after a partial rename
          // does not treat our already-renamed Sheet/xlsx as a conflict.
          await assertConfigSheetNameAvailable(newSheetTitle, {
            hint: 'Choose a different friendly name.',
            excludeFileIds: [
              editCustomer.spreadsheetId,
              editCustomer.sourceFileId,
            ].filter(Boolean),
          });
          await renameDriveFile(editCustomer.spreadsheetId, newSheetTitle);
          if (hasCompanionXlsx) {
            try {
              await renameDriveFile(editCustomer.sourceFileId, newSourceFileName);
            } catch (xlsxErr) {
              // Keep Sheet + xlsx stems aligned; best-effort rollback.
              try {
                await renameDriveFile(editCustomer.spreadsheetId, oldSheetTitle);
              } catch {
                // ignore rollback failure
              }
              throw xlsxErr;
            }
          }
          renamedOnDrive = true;
          // Commit names immediately so local state matches Drive even if
          // Customer-tab sync fails next (avoids a stuck retry loop).
          updateCustomer(editCustomer.id, localNamePatch);
          setEditCustomer((prev) => (prev ? { ...prev, ...localNamePatch } : prev));
        }
        try {
          await syncCustomerToSheet({
            customer: {
              ...editCustomer,
              ...updates,
              ...(renamedOnDrive ? localNamePatch : {}),
              spreadsheetTitle: nameChanged ? newSheetTitle : editCustomer.spreadsheetTitle,
            },
          });
        } catch (syncErr) {
          // Keep form values locally so retry only needs to sync (name already done).
          updateCustomer(editCustomer.id, {
            ...updates,
            ...(nameChanged || renamedOnDrive ? localNamePatch : {}),
          });
          if (renamedOnDrive) {
            fetchCatalog().catch(() => {});
          }
          setEditSyncError(
            syncErr.message
              || (renamedOnDrive
                ? 'Name was updated on Drive, but Customer tab sync failed. Keep this dialog open and try Save again.'
                : 'Customer updated locally, but Google Sheet sync failed. Keep this dialog open and try again in about a minute.'),
          );
          return;
        }
      }
      updateCustomer(editCustomer.id, {
        ...updates,
        ...(nameChanged ? { spreadsheetTitle: newSheetTitle } : {}),
        ...(nameChanged && hasCompanionXlsx ? { sourceFileName: newSourceFileName } : {}),
      });
    } catch (err) {
      setEditSyncError(
        err.message
          || 'Google Drive update failed, so nothing was changed locally. Keep this dialog open and try again in about a minute.',
      );
      return;
    } finally {
      setSavingEdit(false);
    }
    setEditCustomer(null);
    setForm(EMPTY_CUSTOMER_FORM);
    setShowEditModal(false);
    if (nameChanged) {
      fetchCatalog().catch(() => {});
    }
  }, [editCustomer, form, savingEdit, customers, updateCustomer, fetchCatalog]);

  const handleDeleteCustomer = useCallback((customer) => {
    setConfirmDelete({
      message: `Remove "${customer.friendlyName}" from this app? Sites, levels, and devices will be cleared locally.`,
      action: () => removeCustomer(customer.id),
    });
  }, [removeCustomer]);

  const totalSites = useMemo(() =>
    customers.reduce((sum, c) => sum + (c.garages?.length || 0), 0), [customers]);
  const totalLevels = useMemo(() =>
    customers.reduce((sum, c) => sum + (c.garages || []).reduce((s, g) => s + (g.levels?.length || 0), 0), 0), [customers]);
  const totalDevices = useMemo(() =>
    customers.reduce((sum, c) => sum + countGaragesDevices(c.garages), 0), [customers]);
  const customerSummary = useMemo(() => listRows.reduce((summary, row) => {
    if (!row.customer && row.isNativeSheet) summary.sheets += 1;
    if (!row.customer && !row.isNativeSheet) summary.excel += 1;
    if (row.isLocalOnly) summary.localOnly += 1;
    return summary;
  }, { sheets: 0, excel: 0, localOnly: 0 }), [listRows]);

  return (
    <div className="customers-page min-h-screen flex flex-col overflow-x-hidden overscroll-x-none bg-[#1d242c] text-white">
      <header className="h-14 border-b border-[#495057] bg-[#151c23] flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-[19px] font-extrabold tracking-[0.2px]">Customers</h1>
          <nav className="flex items-center gap-2" aria-label="Customer views">
            <span className="rounded border border-[#495057] bg-[#282e35] px-3 py-1.5 text-[11px] font-semibold text-white">
              All Customers
            </span>
            <button
              type="button"
              onClick={() => setShowMap(true)}
              disabled={customers.length === 0}
              className="px-3 py-1.5 text-[11px] text-[#949494] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              title={customers.length === 0 ? 'Open a site first — map shows opened customers only' : 'View opened customer locations on map'}
            >
              Map View
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {authenticated ? (
            <button
              onClick={handleSignOut}
              className="text-[11px] text-[#949494] hover:text-white transition-colors cursor-pointer"
            >
              Sign out
            </button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => handleSignIn(false)} disabled={authLoading} className="h-7 border-[#495057] bg-transparent text-[11px] text-white hover:bg-[#282e35]">
              {authLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Sign in
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={fetchCatalog}
            disabled={!authenticated || catalogLoading || driveAccessDenied}
            className="h-7 border-[#495057] bg-transparent px-3 text-[11px] text-white hover:bg-[#282e35]"
            title={authenticated
              ? 'Refresh list from Drive (does not open or convert files)'
              : 'Sign in to sync from Drive'}
            aria-label="Sync customer list from Google Drive"
          >
            {catalogLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Sync
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowReportIssue(true)}
            className="h-7 border-[#495057] bg-transparent px-3 text-[11px] text-white hover:bg-[#282e35]"
            title="Report an issue or request to ClickUp"
            aria-label="Report issue or request"
          >
            Feedback
          </Button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded-md text-[#949494] hover:bg-[#282e35] hover:text-white cursor-pointer transition-colors"
            title="Settings"
            aria-label="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
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

      <AppSettingsDialog open={showSettings} onOpenChange={setShowSettings} />
      <ReportIssueDialog open={showReportIssue} onOpenChange={setShowReportIssue} />

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <section className="mb-5 flex flex-wrap items-center gap-y-2 border-y border-[#3a424b] bg-[#20272f]/45 px-1 py-2" aria-label="Customer totals">
          {[
            ['Listed', listRows.length, '#49b6d6'],
            ['Opened', customers.length, '#00acac'],
            ['Sites', totalSites, '#f59c1a'],
            ['Levels', totalLevels, '#adb5bd'],
            ['Devices', totalDevices, '#348fe2'],
          ].map(([label, value, color], index) => (
            <div key={label} className={cn('flex min-w-[112px] items-center gap-2.5 px-4 py-1.5', index > 0 && 'border-l border-[#3a424b]')}>
              <span className="h-6 w-[3px] rounded-full" style={{ backgroundColor: color }} />
              <div>
                <div className="text-[20px] font-bold leading-none tabular-nums text-white">{value}</div>
                <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-[#949494]">{label}</div>
              </div>
            </div>
          ))}
        </section>
        {localSaveError && customers.some((c) => !customerCanSyncToSheet(c)) && (
          <div className="mb-4 max-w-4xl mx-auto flex items-start gap-3 p-4 rounded-xl border border-destructive/30 bg-destructive/5">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <p className="font-medium text-destructive">Local save failed</p>
              <p className="text-muted-foreground mt-1 text-xs">{localSaveError}</p>
            </div>
          </div>
        )}

        {catalogError && authenticated && !driveAccessDenied && (
          <div className="mb-4 max-w-4xl mx-auto flex items-start gap-3 p-4 rounded-xl border border-destructive/30 bg-destructive/5">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <p className="font-medium text-destructive">Could not sync Drive catalog</p>
              <p className="text-muted-foreground mt-1 text-xs">{catalogError}</p>
            </div>
            <Button variant="outline" size="sm" onClick={fetchCatalog} disabled={catalogLoading}>
              Retry
            </Button>
          </div>
        )}

        {driveAccessDenied && (
          <div className="mb-4 max-w-4xl mx-auto flex items-start gap-3 p-4 rounded-xl border border-warning/30 bg-warning/10">
            <AlertCircle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <p className="font-medium text-warning">Google Drive access required</p>
              <p className="text-muted-foreground mt-1 text-xs">{authError}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => handleSignIn(true)} disabled={authLoading}>
              Grant Drive Access
            </Button>
          </div>
        )}

        <section className="mb-3 flex flex-wrap items-center gap-3 rounded-[5px] border border-[#3a424b] bg-[#20272f] px-4 py-3">
          <span className="whitespace-nowrap text-[12px] font-semibold uppercase tracking-[0.1em] text-[#949494]">Filter Customers</span>
          <div className="relative w-[260px]">
            <Search className="absolute left-2.5 top-1/2 h-[13px] w-[13px] -translate-y-1/2 text-[#949494]" />
            <Input
              placeholder="…by name/code/city"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-[30px] rounded-[5px] border-[#495057] bg-[#151c23] pl-7 text-[12px] text-white placeholder:text-[#6c757d] focus-visible:ring-1"
              aria-label="Search customers"
            />
          </div>
          <Button
            onClick={() => { setForm(EMPTY_CUSTOMER_FORM); setAddCustomerError(''); setShowAddModal(true); }}
            disabled={!authenticated}
            className="ml-auto h-[30px] rounded-[5px] bg-white px-4 text-[11px] font-bold text-[#151c23] hover:bg-[#e9ecef]"
          >
            <Plus className="h-3 w-3" /> Add Customer
          </Button>
        </section>

        <section className="mb-6 flex flex-wrap items-center gap-2.5 rounded-[5px] border border-[#3a424b] bg-[#20272f] px-4 py-2.5" aria-label="Filter customers by status">
          <span className="border-r border-[#3a424b] pr-4 text-[12px] font-semibold uppercase tracking-[0.1em] text-[#949494]">Status</span>
          {[
            { key: 'all', label: 'All', count: listRows.length, color: '#adb5bd', description: 'Show every listed customer' },
            { key: 'opened', label: 'Opened', count: customers.length, color: '#00acac', description: 'Customers loaded into this browser, including customers that are synced to Drive' },
            { key: 'sheets', label: 'Google Sheet', count: customerSummary.sheets, color: '#49b6d6', description: 'Drive customers that have not been opened in this browser' },
            { key: 'excel', label: 'Excel — not converted', count: customerSummary.excel, color: '#f59c1a', description: 'Excel customers waiting to be opened and converted' },
            { key: 'local', label: 'Not in Drive', count: customerSummary.localOnly, color: '#ff5b57', description: 'Opened customers with no matching file in the shared Drive folder' },
          ].map(({ key, label, count, color, description }) => {
            const active = statusFilter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                aria-pressed={active}
                title={description}
                className="rounded-full border px-3 py-1 text-[11px] font-medium transition-all hover:-translate-y-px hover:brightness-125"
                style={{
                  color,
                  borderColor: `${color}${active ? 'cc' : '73'}`,
                  backgroundColor: active ? `${color}1f` : 'transparent',
                  boxShadow: active ? `0 0 0 1px ${color}33, 0 3px 10px rgba(0,0,0,.18)` : 'none',
                }}
              >
                {label} ({count})
              </button>
            );
          })}
        </section>

        {authenticated && catalogLoading && !catalogFetched && (
          <div className="max-w-md mx-auto text-center py-12 text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading site configs from Drive…
          </div>
        )}

        {listRows.length > 0 && filteredRows.length === 0 && (
          <div className="max-w-md mx-auto text-center py-12">
            <Search className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <h2 className="text-base font-semibold mb-1">No matching customers</h2>
            <p className="text-sm text-muted-foreground mb-4">
              No customers match the current search and status filters.
            </p>
            <Button variant="outline" size="sm" onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}>
              Clear filters
            </Button>
          </div>
        )}

        {!catalogLoading && listRows.length === 0 && (
          <div className="max-w-md mx-auto text-center py-16">
            <Users className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">No sites yet</h2>
            <p className="text-sm text-muted-foreground mb-6">
              {authenticated
                ? 'No config files found in the shared Drive folder. Add a customer to create a Google Sheet, or Sync after new files are added.'
                : 'Sign in with Google to load site configs from Drive. Adding a customer also requires sign-in so a Sheet can be created.'}
            </p>
            <div className="flex items-center justify-center gap-3">
              <Button onClick={() => setShowAddModal(true)} disabled={!authenticated}>
                <Plus className="w-4 h-4" /> Add Customer
              </Button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 items-start">
          {filteredRows.map((row) => {
            const customer = row.customer;
            const detailsId = customer ? `customer-details-${customer.id}` : undefined;
            const isExpanded = customer ? expandedCustomerIds.has(customer.id) : false;
            const siteCount = customer?.garages?.length || 0;
            const levelCount = (customer?.garages || []).reduce((s, g) => s + (g.levels?.length || 0), 0);
            const deviceCount = customer ? countGaragesDevices(customer.garages) : 0;
            const customerConfig = customer ? normalizeCustomerConfig(customer) : null;
            const localTime = customerConfig?.state ? getLocalTime(customerConfig.state) : null;
            const weatherAddr = customer ? customerWeatherAddress(customer) : null;
            const support = customerConfig?.support || {};
            // Un-opened rows: shared metadata stamped on the Drive file by whoever
            // last saved the customer (see buildConfigFileAppProperties).
            const catalogMeta = customer
              ? null
              : configFileMetaFromAppProperties(row.catalogRow?.file?.appProperties);
            const isEnterprise = customer
              ? support.enterpriseSite
              : Boolean(catalogMeta?.enterpriseSite);
            const show24Hour = customer
              ? Boolean(support.support24Hour)
              : Boolean(catalogMeta?.support24Hour);
            const displaySiteCount = customer ? siteCount : (catalogMeta?.siteCount ?? 0);
            const statusColor = row.isLocalOnly
              ? '#ff5b57'
              : customer ? '#00acac' : row.isNativeSheet ? '#49b6d6' : '#f59c1a';

            return (
              <Card
                key={row.id}
                className={cn(
                  'self-start w-full h-auto overflow-hidden rounded-xl border bg-[#282e35] text-white transition-all duration-200 shadow-[0_.125rem_.25rem_rgba(0,0,0,.3)]',
                  // Expanded cards grow over the next grid row; raise them so Open/Reload
                  // clicks are not stolen by overlapping sibling cards.
                  isExpanded && 'relative z-20',
                  isExpanded
                    ? 'border-[#495057] shadow-[0_.5rem_1rem_rgba(0,0,0,.5)]'
                    : 'border-[#3a424b] hover:border-[#495057]',
                )}
              >
                <CardContent className="p-0">
                  <div className="w-full flex items-center gap-2 px-3.5 py-3 rounded-t-xl">
                    <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ backgroundColor: statusColor }} aria-hidden="true" />
                    <button
                      type="button"
                      onClick={() => handleRowActivate(row)}
                      className="flex-1 min-w-0 text-left cursor-pointer hover:opacity-90"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <h3 className={cn('truncate text-[14px] font-bold leading-tight', !customer && 'text-[#adb5bd]')}>
                          {row.displayName}
                        </h3>
                        {row.isLocalOnly && (
                          <span
                            className="shrink-0 rounded-full border border-[#ff5b57]/50 px-2 py-0.5 text-[9px] font-semibold uppercase text-[#ff5b57]"
                            title="Not in the shared Drive folder (or removed from Drive). Still available in this app."
                          >
                            Local
                          </span>
                        )}
                        {isEnterprise && (
                          <span className="shrink-0 rounded-full border border-[#f59c1a]/50 px-2 py-0.5 text-[9px] font-semibold uppercase text-[#f59c1a]">
                            ENT
                          </span>
                        )}
                        {show24Hour && (
                          <span className="shrink-0 rounded-full border border-[#49b6d6]/50 px-2 py-0.5 text-[9px] font-semibold uppercase text-[#49b6d6]">
                            24H
                          </span>
                        )}
                      </div>
                      {!customer && (
                        <p className="mt-0.5 truncate text-[10px] text-[#6c757d]">
                          {row.isNativeSheet ? 'Google Sheet · not opened yet' : 'Excel · opens as Google Sheet'}
                          {row.catalogRow?.duplicateFiles?.length
                            ? ` · ${row.catalogRow.duplicateFiles.length} duplicate name${row.catalogRow.duplicateFiles.length === 1 ? '' : 's'} in Drive`
                            : ''}
                        </p>
                      )}
                    </button>
                    {displaySiteCount > 0 && (
                      <span className="flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full border border-[#495057] bg-[#1d242c] px-1.5 text-[10px] font-bold text-[#adb5bd]">
                        {displaySiteCount}
                      </span>
                    )}
                    {customer ? (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(customer.id)}
                        className="p-1 rounded-md text-[#949494] hover:bg-[#1d242c] hover:text-white cursor-pointer"
                        aria-expanded={isExpanded}
                        aria-controls={detailsId}
                        aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                      >
                        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[#949494]" />
                    )}
                  </div>

                  {customer && (
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <MotionDiv
                          id={detailsId}
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: 'easeOut' }}
                          className="overflow-hidden"
                        >
                          <div className="flex flex-col gap-2 border-t border-[#3a424b] px-3.5 py-3 text-[11px] text-[#adb5bd]">
                            <div className="flex flex-wrap gap-1.5">
                              <span className="rounded-full border border-[#00acac]/50 px-2.5 py-0.5 text-[10px] font-semibold text-[#00acac]">Opened</span>
                              {isEnterprise && <span className="rounded-full border border-[#f59c1a]/50 px-2.5 py-0.5 text-[10px] font-semibold text-[#f59c1a]">Enterprise</span>}
                              {show24Hour && <span className="rounded-full border border-[#49b6d6]/50 px-2.5 py-0.5 text-[10px] font-semibold text-[#49b6d6]">24h</span>}
                            </div>
                            <p className="flex items-center gap-2"><span className="h-[9px] w-[9px] rounded-full bg-[#00acac]" />{customer.spreadsheetId ? 'Synced to Google Sheet' : 'Opened locally'}</p>
                            <p className="flex items-center gap-2"><span className="h-[9px] w-[9px] rounded-full bg-[#6c757d]" />{siteCount} sites · {levelCount} levels · {deviceCount} devices</p>
                            {(customerConfig.city || localTime || weatherAddr) && (
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="h-[9px] w-[9px] shrink-0 rounded-full bg-[#6c757d]" />
                                <span className="truncate">{[customerConfig.city, customerConfig.state].filter(Boolean).join(', ')}{localTime ? ` · ${localTime}` : ''}</span>
                                {weatherAddr && <span className="ml-auto shrink-0"><Weather address={weatherAddr} /></span>}
                              </div>
                            )}
                            <p className="truncate font-mono text-[10.5px] text-[#6c757d]">
                              {customer.code || customerCodeFromId(customer.customerId)}
                              {(customerConfig.address || customerConfig.city) && ` · ${[customerConfig.address, customerConfig.city, customerConfig.state].filter(Boolean).join(', ')}${customerConfig.zip ? ` ${customerConfig.zip}` : ''}`}
                            </p>
                            <div className="mt-0.5 grid grid-cols-4 gap-2">
                              {(() => {
                                const openHref = mapsOpenUrl(customerConfig.mapsUrl, weatherAddr);
                                return openHref ? (
                                  <a href={openHref} target="_blank" rel="noopener noreferrer" className="rounded-[5px] border border-[#495057] px-2 py-1.5 text-center text-[10.5px] font-semibold hover:bg-[#1d242c]">Maps</a>
                                ) : <span className="rounded-[5px] border border-[#3a424b] px-2 py-1.5 text-center text-[10.5px] text-[#6c757d]">Maps</span>;
                              })()}
                              <button type="button" onClick={() => setSupportDialogCustomer(customer)} className="rounded-[5px] border border-[#495057] px-2 py-1.5 text-[10.5px] font-semibold hover:bg-[#1d242c]">Support</button>
                              <button type="button" onClick={() => openEditCustomer(customer)} className="rounded-[5px] border border-[#495057] px-2 py-1.5 text-[10.5px] font-semibold hover:bg-[#1d242c]" aria-label={`Edit customer ${customer.friendlyName}`}>Edit</button>
                              <button type="button" onClick={() => handleDeleteCustomer(customer)} className="rounded-[5px] border border-[#ff5b57]/40 px-2 py-1.5 text-[10.5px] font-semibold text-[#ff5b57] hover:bg-[#ff5b57]/10" aria-label={`Delete customer ${customer.friendlyName}`}>Delete</button>
                            </div>
                            <div className="mt-0.5 flex items-center justify-between">
                              {row.catalogRow?.file ? (
                                <button type="button" onClick={() => handleAskReloadFromDrive(row)} className="text-[10px] text-[#6c757d] hover:text-[#adb5bd]">Reload from Drive…</button>
                              ) : <span />}
                              <button type="button" onClick={() => selectCustomer(customer.id)} className="text-[11px] font-bold text-white hover:text-[#c9d2da]">Open →</button>
                            </div>
                          </div>
                        </MotionDiv>
                      )}
                    </AnimatePresence>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {filteredRows.length > 0 && (
          <p className="mt-6 text-center text-[12px] text-[#6c757d]">
            Showing {filteredRows.length} of {listRows.length} customers
          </p>
        )}
      </div>

      {/* Add Customer Modal */}
      <Dialog open={showAddModal} onOpenChange={(open) => { setShowAddModal(open); if (!open) setAddCustomerError(''); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Customer</DialogTitle>
            <DialogDescription>
              Creates a Google Sheet named like &ldquo;Stanford Health Care-config&rdquo; in the shared Drive folder.
            </DialogDescription>
          </DialogHeader>
          <CustomerFormFields form={form} setForm={setForm} />
          {addCustomerError && (
            <p className="text-sm text-destructive">{addCustomerError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddModal(false)} disabled={addingCustomer}>Cancel</Button>
            <Button onClick={handleAddCustomer} disabled={!form.friendlyName.trim() || addingCustomer}>
              {addingCustomer ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Add Customer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Customer Modal */}
      <Dialog open={showEditModal} onOpenChange={(open) => {
        if (!open) {
          if (savingEdit) return;
          setEditCustomer(null);
          setForm(EMPTY_CUSTOMER_FORM);
          setEditSyncError('');
        }
        setShowEditModal(open);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Customer</DialogTitle>
            <DialogDescription>
              Customer ID: <span className="font-mono">{editCustomer?.code || editCustomer?.customerId}</span>
            </DialogDescription>
          </DialogHeader>
          <CustomerFormFields form={form} setForm={setForm} />
          {editSyncError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-sm font-medium text-destructive">Sheet sync failed</p>
              <p className="text-sm text-destructive mt-1">{editSyncError}</p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingEdit}
              onClick={() => {
                setShowEditModal(false);
                setEditCustomer(null);
                setForm(EMPTY_CUSTOMER_FORM);
                setEditSyncError('');
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={!form.friendlyName.trim() || savingEdit}>
              {savingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showMap && (
        <Suspense fallback={(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-xl">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading map…
            </div>
          </div>
        )}
        >
          <CustomerMapDialog
            open={showMap}
            onOpenChange={setShowMap}
            customers={customers}
          />
        </Suspense>
      )}

      <CustomerSupportDialog
        customer={supportDialogCustomer}
        open={Boolean(supportDialogCustomer)}
        onOpenChange={(open) => { if (!open) setSupportDialogCustomer(null); }}
      />

      {/* Drive open progress / reload confirmation */}
      <Dialog
        open={!!confirmOpenRow}
        onOpenChange={(open) => {
          if (!open) handleCancelOpenConfig();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmOpenMode === 'reload'
                ? 'Reload from Drive?'
                : (openingConfig ? 'Opening…' : 'Could not open')}
            </DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">
                <span className="font-medium text-foreground">{confirmOpenRow?.displayName}</span>
              </span>
              {confirmOpenMode === 'reload' ? (
                <span className="block text-muted-foreground">
                  Open your current local copy, or reload from Drive (uses SetupJson when present;
                  otherwise sheet tabs). Reload replaces local layout data for this customer.
                </span>
              ) : (
                <span className="block text-muted-foreground">
                  {openingConfig
                    ? (confirmOpenRow?.isNativeSheet && !confirmOpenRow?.catalogRow?.sourceXlsxFile
                      ? 'Loading shared config…'
                      : 'Writing Google Sheet tabs from Excel… this can take a minute for larger files.')
                    : 'Something went wrong. Retry or cancel.'}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {openingConfig && (!confirmOpenRow?.isNativeSheet || confirmOpenRow?.catalogRow?.sourceXlsxFile) && (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              You can Cancel if this stalls.
            </p>
          )}
          {openConfigError && (
            <p className="text-sm text-destructive">{openConfigError}</p>
          )}
          <DialogFooter className="gap-2 sm:gap-0 flex-col sm:flex-row">
            <Button
              variant="outline"
              onClick={handleCancelOpenConfig}
            >
              Cancel
            </Button>
            {confirmOpenMode === 'reload' && (
              <Button variant="outline" onClick={handleConfirmOpenOnly} disabled={openingConfig}>
                Open local
              </Button>
            )}
            {(confirmOpenMode === 'reload' || openConfigError) && (
              <Button onClick={handleConfirmReloadFromDrive} disabled={openingConfig}>
                {openingConfig ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {confirmOpenMode === 'reload' ? 'Reload from Drive' : 'Retry'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">{confirmDelete?.message}</span>
              <span className="block text-muted-foreground">
                The linked Google Sheet or Drive file is not deleted. Sync will list it again as not opened yet.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { confirmDelete?.action(); setConfirmDelete(null); }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
