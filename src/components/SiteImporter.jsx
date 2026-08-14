import React, { useState, useCallback, useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import { useAppStore } from '../stores/useAppStore';
import { formatFileSize } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import {
  listXlsxFiles,
  downloadFile,
  isSignedIn,
  signInWithGoogle,
} from '../services/GoogleDriveService';
import { parseExcelFile, getImportSummary } from '../services/ExcelParserService';
import {
  prepareImportFromDriveFile,
  customerSheetQuickLink,
} from '../services/ConfigSheetSyncService';
import {
  customerIdFromFileName,
  customerCodeFromFileName,
  mergeGarages,
  customerConfigPatch,
  normalizeCustomerConfig,
} from '../lib/customerUtils';
import { defaultCustomerConfig } from '../lib/configSheetSchema';
import {
  Upload, Search, X, Check, FileSpreadsheet, FolderOpen,
  AlertCircle, Loader2, Package, Layers, Cpu,
  LayoutGrid, ArrowLeft, RefreshCw, Replace,
} from 'lucide-react';

function formatDate(isoString) {
  if (!isoString) return '--';
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function addressFromFirstGarage(garages) {
  const g = garages?.[0];
  if (!g) return defaultCustomerConfig();
  return {
    address: g.address || '',
    city: g.city || '',
    state: g.state || '',
    zip: g.zip || '',
    mapsUrl: g.mapsUrl || '',
    support: defaultCustomerConfig().support,
  };
}

function attachConfigSheetLink(garages, sheetMeta, selectedFile) {
  const sheetLink = sheetMeta
    ? customerSheetQuickLink(sheetMeta.spreadsheetTitle, sheetMeta.spreadsheetUrl)
    : null;
  const driveLink = selectedFile
    ? (selectedFile.webViewLink || `https://drive.google.com/file/d/${selectedFile.id}/view`)
    : null;
  if (!sheetLink && !driveLink) return garages;

  return garages.map((garage) => {
    const existing = (garage.quickLinks || []).filter((l) => l.icon !== 'sheets');
    const primaryLink = sheetLink || {
      id: 1,
      name: selectedFile.name.replace(/\.xlsx?$/i, '') || 'Configuration Sheet',
      url: driveLink,
      icon: 'sheets',
    };
    return {
      ...garage,
      quickLinks: [primaryLink, ...existing],
    };
  });
}

export default function SiteImporter() {
  const {
    customers, addCustomer, updateCustomer, selectCustomer, setCurrentView,
  } = useAppStore();

  const [files, setFiles] = useState([]);
  const [nextPageToken, setNextPageToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState('');
  const searchDebounceRef = useRef(null);

  const [selectedFile, setSelectedFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [friendlyName, setFriendlyName] = useState('');
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const [existingCustomer, setExistingCustomer] = useState(null);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [showMergeWarning, setShowMergeWarning] = useState(false);
  const [showReplaceWarning, setShowReplaceWarning] = useState(false);
  const [showReplaceFinal, setShowReplaceFinal] = useState(false);
  const [driveForbidden, setDriveForbidden] = useState(false);
  const [reauthing, setReauthing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  const loadFiles = useCallback(async (query = '') => {
    if (!isSignedIn()) {
      setError('Session expired. Please sign in again from the customer list.');
      return;
    }
    setLoading(true);
    setError('');
    setDriveForbidden(false);
    try {
      const result = await listXlsxFiles({ searchQuery: query });
      setFiles(result.files);
      setNextPageToken(result.nextPageToken);
    } catch (err) {
      setError(err.message);
      setDriveForbidden(err.code === 'DRIVE_FORBIDDEN');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleGrantDriveAccess = useCallback(async () => {
    setReauthing(true);
    setError('');
    try {
      await signInWithGoogle({ prompt: 'consent' });
      setDriveForbidden(false);
      await loadFiles(searchQuery);
    } catch (err) {
      setError(err.message || 'Failed to grant Drive access');
    } finally {
      setReauthing(false);
    }
  }, [loadFiles, searchQuery]);

  useEffect(() => {
    if (!isSignedIn()) {
      setError('Sign in from the customer list to import configurations.');
      return;
    }
    loadFiles();
  }, [loadFiles]);

  const performSearch = useCallback(async (query) => {
    await loadFiles(query);
  }, [loadFiles]);

  const handleSearchChange = useCallback((e) => {
    const val = e.target.value;
    setSearchQuery(val);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => performSearch(val), 400);
  }, [performSearch]);

  const handleLoadMore = useCallback(async () => {
    if (!nextPageToken || loading) return;
    setLoading(true);
    try {
      const result = await listXlsxFiles({ pageToken: nextPageToken, searchQuery });
      setFiles((prev) => [...prev, ...result.files]);
      setNextPageToken(result.nextPageToken);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [nextPageToken, loading, searchQuery]);

  const handleImport = useCallback(async () => {
    if (!selectedFile) return;
    setImporting(true);
    setError('');
    try {
      const buffer = await downloadFile(selectedFile.id);
      const parsed = parseExcelFile(buffer);
      const summary = getImportSummary(parsed);
      const cid = customerIdFromFileName(selectedFile.name);
      const existing = customers.find((c) => c.customerId === cid);
      setImportResult({ parsed, summary, fileName: selectedFile.name, customerId: cid });
      setFriendlyName(existing?.friendlyName || customerCodeFromFileName(selectedFile.name));
      setExistingCustomer(existing || null);
      setShowConfirmModal(true);
    } catch (err) {
      setError(err.message || 'Failed to import file');
    } finally {
      setImporting(false);
    }
  }, [selectedFile, customers]);

  const closeAllModals = useCallback(() => {
    setShowConfirmModal(false);
    setShowConflictModal(false);
    setShowMergeWarning(false);
    setShowReplaceWarning(false);
    setShowReplaceFinal(false);
    setImportResult(null);
    setExistingCustomer(null);
    setSelectedFile(null);
  }, []);

  /**
   * Push the freshly imported layout to the customer's SetupJson, then open it.
   *
   * Import only rewrites the config tabs from the workbook — it never touches
   * SetupJson. So for merge and replace the sheet still holds the pre-import
   * snapshot, and `selectCustomer` loads it the moment we navigate, putting the
   * app back exactly where it started and losing the import silently.
   *
   * The import is the new truth for this customer, so it is written first. The
   * save is forced: the user has just chosen to merge or replace, so prompting
   * them about the layout they are deliberately superseding would be wrong. If
   * the write fails we stay put and say so, rather than navigating into a view
   * that would quietly revert.
   */
  const commitImportedLayout = useCallback(async (customerId) => {
    const store = useAppStore.getState();
    // We know this layout — it came from the file the user just picked — so the
    // hydration gate has nothing to protect against here.
    store.setHydration(customerId, 'hydrated');
    await store.saveCustomerSetupToSheet(customerId, { force: true });

    const { setupSync } = useAppStore.getState();
    if (setupSync.customerId === customerId && setupSync.status === 'error') {
      setError(setupSync.error || 'Imported data could not be saved to the sheet.');
      return;
    }
    closeAllModals();
    selectCustomer(customerId);
  }, [closeAllModals, selectCustomer]);

  const finalizeImport = useCallback(async (mode) => {
    if (!importResult || !selectedFile || finalizing) return;
    setFinalizing(true);
    setError('');
    try {
      const cid = importResult.customerId;
      const code = customerCodeFromFileName(selectedFile.name);
      const name = friendlyName.trim() || code;

      const sheetMeta = await prepareImportFromDriveFile({
        friendlyName: name,
        sourceFile: selectedFile,
        rawData: importResult.parsed.rawData,
        sheetNames: importResult.parsed.sheetNames,
        existingSpreadsheetId: mode !== 'new' ? existingCustomer?.spreadsheetId : null,
      });

      const garagesWithLink = attachConfigSheetLink(importResult.parsed.garages, sheetMeta, selectedFile);
      const displaySchedules = importResult.parsed.rawData?.displaySchedules || [];
      const sheetFields = {
        spreadsheetId: sheetMeta.spreadsheetId,
        spreadsheetUrl: sheetMeta.spreadsheetUrl,
        spreadsheetTitle: sheetMeta.spreadsheetTitle,
        sourceFileId: sheetMeta.sourceFileId,
        sourceFileName: sheetMeta.sourceFileName,
        // Kept on the customer so SetupJson round-trips schedules (no editor UI yet).
        displaySchedules,
      };

      if (mode === 'new') {
        const importedConfig = addressFromFirstGarage(garagesWithLink);
        const customer = addCustomer({
          customerId: cid,
          code,
          friendlyName: name,
          config: importedConfig,
          garages: garagesWithLink,
          ...sheetFields,
        });
        await commitImportedLayout(customer.id);
        return;
      }

      if (mode === 'merge') {
        const merged = mergeGarages(existingCustomer.garages || [], garagesWithLink);
        const importedConfig = addressFromFirstGarage(garagesWithLink);
        const existingConfig = normalizeCustomerConfig(existingCustomer);
        const needsAddress = !existingConfig.address && !existingConfig.city;
        const updates = {
          friendlyName: name,
          garages: merged,
          ...sheetFields,
          ...(needsAddress ? customerConfigPatch(existingCustomer, importedConfig) : {}),
        };
        updateCustomer(existingCustomer.id, updates);
        await commitImportedLayout(existingCustomer.id);
        return;
      }

      if (mode === 'replace') {
        const importedConfig = addressFromFirstGarage(garagesWithLink);
        const updates = {
          friendlyName: name,
          garages: garagesWithLink,
          config: importedConfig,
          ...sheetFields,
        };
        updateCustomer(existingCustomer.id, updates);
        await commitImportedLayout(existingCustomer.id);
      }
    } catch (err) {
      setError(err.message || 'Import failed.');
    } finally {
      setFinalizing(false);
    }
  }, [importResult, selectedFile, friendlyName, existingCustomer, addCustomer, updateCustomer, commitImportedLayout, finalizing]);

  const handleConfirmDetails = useCallback(() => {
    if (!importResult) return;
    if (existingCustomer) {
      setShowConfirmModal(false);
      setShowConflictModal(true);
    } else {
      finalizeImport('new');
    }
  }, [importResult, existingCustomer, finalizeImport]);

  const handleBack = useCallback(() => {
    closeAllModals();
    setCurrentView('customers');
  }, [setCurrentView, closeAllModals]);

  useEffect(() => {
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-14 border-b-2 border-header-border bg-header-bg flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={handleBack} className="p-1.5 rounded-md hover:bg-accent cursor-pointer transition-colors" title="Back to customers">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-primary" />
            <h1 className="text-lg font-semibold">Import Customer</h1>
          </div>
        </div>
      </header>

      <div className="flex-1 flex items-start justify-center p-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="w-full max-w-xl glass-strong rounded-2xl overflow-hidden shadow-2xl"
        >
          <div className="px-6 py-4 border-b border-border">
            <p className="text-sm text-muted-foreground">
              Select an Excel configuration file. A customer will be created from the file name.
            </p>
          </div>

          <div className="px-6 py-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search files..."
                value={searchQuery}
                onChange={handleSearchChange}
                className="pl-9 pr-9 h-9"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); performSearch(''); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="px-6 py-3 border-b border-border">
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="flex-1">{error}</p>
              </div>
              {driveForbidden && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={handleGrantDriveAccess}
                  disabled={reauthing}
                >
                  {reauthing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Grant Drive Access
                </Button>
              )}
            </div>
          )}

          <div className="max-h-[360px] overflow-y-auto">
            {files.length === 0 && !loading && (
              <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
                <FileSpreadsheet className="w-10 h-10 opacity-30" />
                <p className="text-sm">No .xlsx files found{searchQuery ? ` matching "${searchQuery}"` : ''}</p>
              </div>
            )}

            {files.map((file) => (
              <button
                key={file.id}
                type="button"
                onClick={() => { setSelectedFile(file); setImportResult(null); }}
                aria-selected={selectedFile?.id === file.id}
                className={`w-full flex items-center gap-3 px-6 py-3 text-left cursor-pointer transition-all duration-150 border-b border-border/50 hover:bg-accent/50 ${
                  selectedFile?.id === file.id ? 'bg-primary/8 border-l-2 border-l-primary' : ''
                }`}
              >
                <FileSpreadsheet className="w-5 h-5 text-success shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(file.modifiedTime)} · {formatFileSize(file.size)}
                    {file.owners?.[0]?.displayName && ` · ${file.owners[0].displayName}`}
                  </p>
                </div>
                {selectedFile?.id === file.id && (
                  <Check className="w-5 h-5 text-primary shrink-0" />
                )}
              </button>
            ))}

            {loading && (
              <div className="py-8 flex items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading files...</span>
              </div>
            )}

            {nextPageToken && !loading && (
              <button
                onClick={handleLoadMore}
                className="w-full py-3 text-sm text-primary hover:bg-accent/50 cursor-pointer transition-colors"
              >
                Load more files
              </button>
            )}
          </div>

          {selectedFile && (
            <div className="px-6 py-4 border-t border-border flex items-center justify-between">
              <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                {selectedFile.name}
              </p>
              <Button onClick={handleImport} disabled={importing} size="sm">
                {importing ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Importing...</>
                ) : (
                  <><Upload className="w-4 h-4" /> Import</>
                )}
              </Button>
            </div>
          )}
        </motion.div>
      </div>

      {/* Import Details Modal */}
      <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-primary" />
              Import Summary
            </DialogTitle>
            <DialogDescription>{importResult?.fileName}</DialogDescription>
          </DialogHeader>

          {importResult && (
            <div className="space-y-4">
              <div className="space-y-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Customer ID</Label>
                  <Input
                    value={customerCodeFromFileName(importResult.fileName)}
                    readOnly
                    className="mt-1 font-mono bg-muted/50"
                  />
                </div>
                <div>
                  <Label>Friendly Name</Label>
                  <Input
                    value={friendlyName}
                    onChange={(e) => setFriendlyName(e.target.value)}
                    placeholder="Stanford Health Care"
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                {[
                  { icon: Package, label: 'Garages', value: importResult.summary.totalGarages, color: 'text-primary' },
                  { icon: Layers, label: 'Levels', value: importResult.summary.totalLevels, color: 'text-success' },
                  { icon: Cpu, label: 'Devices', value: importResult.summary.totalDevices, color: 'text-warning' },
                ].map(({ icon: StatIcon, label, value, color }) => (
                  <div key={label} className="flex flex-col items-center gap-1 p-3 rounded-lg bg-muted/50">
                    <StatIcon className={`w-5 h-5 ${color}`} />
                    <span className="text-xl font-bold">{value}</span>
                    <span className="text-xs text-muted-foreground">{label}</span>
                  </div>
                ))}
              </div>

              <p className="text-[11px] text-muted-foreground leading-snug">
                Import updates app state and creates a Google Sheet copy for sync (same tabs and data).
                The original .xlsx stays on Drive. SetupJson auto-saves when you are signed in.
              </p>

              <div className="rounded-lg border border-border overflow-hidden">
                <div className="px-3 py-2 bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <LayoutGrid className="w-3.5 h-3.5" /> Sheet Data
                </div>
                <div className="divide-y divide-border max-h-40 overflow-y-auto">
                  {Object.entries(importResult.summary.tabCounts).map(([tab, count]) => (
                    <div key={tab} className="px-3 py-1.5 flex justify-between text-sm">
                      <span>{tab}</span>
                      <span className="text-muted-foreground">{count} rows</span>
                    </div>
                  ))}
                </div>
              </div>

              {importResult.summary.skippedDisplayLevelRows > 0 && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                  <span>
                    {importResult.summary.skippedDisplayLevelRows} display level row
                    {importResult.summary.skippedDisplayLevelRows !== 1 ? 's were' : ' was'} skipped
                    because the level name did not match any level in the garage.
                  </span>
                </div>
              )}

              {!existingCustomer && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-primary/10 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
                  <span>A new customer will be created with the garages from this file.</span>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirmModal(false)}>Cancel</Button>
            <Button onClick={handleConfirmDetails} disabled={!friendlyName.trim()}>
              <Check className="w-4 h-4" /> Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Existing Customer Conflict Modal */}
      <Dialog open={showConflictModal} onOpenChange={setShowConflictModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Customer Already Exists</DialogTitle>
            <DialogDescription>
              Customer <span className="font-mono font-medium">{existingCustomer?.code || existingCustomer?.customerId}</span> ({existingCustomer?.friendlyName}) already exists. How would you like to import?
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <button
              onClick={() => { setShowConflictModal(false); setShowMergeWarning(true); }}
              className="w-full flex items-start gap-3 p-4 rounded-lg border border-border hover:border-primary/40 hover:bg-accent/50 transition-colors cursor-pointer text-left"
            >
              <RefreshCw className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-sm">Merge / Update</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Update matching sites by name and add any new sites from the import. Sites not in the file are kept.
                </p>
              </div>
            </button>
            <button
              onClick={() => { setShowConflictModal(false); setShowReplaceWarning(true); }}
              className="w-full flex items-start gap-3 p-4 rounded-lg border border-destructive/30 hover:border-destructive/50 hover:bg-destructive/5 transition-colors cursor-pointer text-left"
            >
              <Replace className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-sm text-destructive">Replace All Sites</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Remove all existing sites and replace them entirely with the imported data.
                </p>
              </div>
            </button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowConflictModal(false); setShowConfirmModal(true); }}>Back</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge Warning */}
      <Dialog open={showMergeWarning} onOpenChange={setShowMergeWarning}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm Merge / Update</DialogTitle>
            <DialogDescription>
              This will update sites that match by name with data from the import file. Any sites in the file that don&apos;t exist yet will be added. Existing sites not in the file will be kept.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 text-warning text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Device layouts and level data on matching sites will be overwritten with the imported data.</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowMergeWarning(false); setShowConflictModal(true); }}>Back</Button>
            <Button onClick={() => finalizeImport('merge')} disabled={finalizing}>
              <Check className="w-4 h-4" /> Merge / Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace Warning (step 1) */}
      <Dialog open={showReplaceWarning} onOpenChange={setShowReplaceWarning}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-destructive">Replace All Sites?</DialogTitle>
            <DialogDescription>
              This will permanently remove all existing sites, levels, and devices for <strong>{existingCustomer?.friendlyName}</strong> and replace them with the imported data.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>This action cannot be undone. All manual edits to sites, levels, and devices will be lost.</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowReplaceWarning(false); setShowConflictModal(true); }}>Back</Button>
            <Button variant="destructive" onClick={() => { setShowReplaceWarning(false); setShowReplaceFinal(true); }}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace Final Warning (step 2) */}
      <Dialog open={showReplaceFinal} onOpenChange={setShowReplaceFinal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-destructive">Are you absolutely sure?</DialogTitle>
            <DialogDescription>
              You are about to delete <strong>{existingCustomer?.garages?.length || 0} site(s)</strong> and all their data. Type nothing — just confirm you understand this is irreversible.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowReplaceFinal(false); setShowReplaceWarning(true); }}>Back</Button>
            <Button variant="destructive" onClick={() => finalizeImport('replace')} disabled={finalizing}>
              <Replace className="w-4 h-4" /> Replace Everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
