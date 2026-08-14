import React from 'react';
import { useAppStore } from '../stores/useAppStore';
import { customerCanSyncToSheet } from '../lib/customerConfigUtils';
import { Loader2, Cloud, CloudOff, AlertCircle, RefreshCw } from 'lucide-react';

function formatSavedTime(savedAt) {
  if (!savedAt) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(savedAt));
  } catch {
    return null;
  }
}

/**
 * Inline status chip for shared SetupJson layout persistence (map / devices / zones).
 * Distinct from config-tab field sync (Cameras, DisplayControllers, etc.).
 */
export default function SetupSyncIndicator() {
  const setupSync = useAppStore((s) => s.setupSync);
  const selectedCustomerId = useAppStore((s) => s.selectedCustomerId);
  const customers = useAppStore((s) => s.customers);
  const retrySetupSync = useAppStore((s) => s.retrySetupSync);
  const resolveSetupConflictReload = useAppStore((s) => s.resolveSetupConflictReload);
  const resolveSetupConflictOverwrite = useAppStore((s) => s.resolveSetupConflictOverwrite);
  const loadSetupFromSheet = useAppStore((s) => s.loadSetupFromSheet);

  const customer = customers.find((c) => c.id === selectedCustomerId) ?? null;
  const canShare = customerCanSyncToSheet(customer);

  if (!selectedCustomerId) return null;

  const { status, error, savedAt, customerId } = setupSync;
  const isForCustomer = customerId === selectedCustomerId;

  if (isForCustomer && status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading shared layout…
      </span>
    );
  }

  if (isForCustomer && status === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Saving shared layout…
      </span>
    );
  }

  if (isForCustomer && status === 'conflict') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300" role="alert">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        <span className="max-w-[220px] truncate" title={error}>{error || 'Shared layout conflict'}</span>
        <button
          type="button"
          onClick={resolveSetupConflictReload}
          className="underline underline-offset-2 hover:opacity-80 cursor-pointer shrink-0"
        >
          Reload
        </button>
        <button
          type="button"
          onClick={resolveSetupConflictOverwrite}
          className="underline underline-offset-2 hover:opacity-80 cursor-pointer shrink-0"
        >
          Overwrite
        </button>
      </span>
    );
  }

  if (isForCustomer && status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-destructive" role="status">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        <span className="max-w-[280px] truncate" title={error}>{error}</span>
        <button
          type="button"
          onClick={retrySetupSync}
          className="underline underline-offset-2 hover:text-destructive/80 cursor-pointer shrink-0"
        >
          Retry
        </button>
      </span>
    );
  }

  if (isForCustomer && status === 'unavailable') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        title="Needs a Google Sheet — open this site from Drive to create one for shared layout sync."
        role="status"
      >
        <CloudOff className="w-3.5 h-3.5" />
        Needs a Google Sheet
      </span>
    );
  }

  if (isForCustomer && (status === 'saved' || status === 'loaded')) {
    const time = formatSavedTime(savedAt);
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400" role="status">
        <Cloud className="w-3.5 h-3.5" />
        {time ? `Shared layout ${time}` : 'Shared layout synced'}
        <button
          type="button"
          onClick={() => loadSetupFromSheet(selectedCustomerId)}
          className="p-0.5 rounded hover:bg-accent cursor-pointer text-muted-foreground hover:text-foreground"
          title="Refresh shared layout from Google Sheet"
          aria-label="Refresh shared layout"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </span>
    );
  }

  if (canShare) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        title="Map layout, devices, and zones sync to the SetupJson tab on the linked Google Sheet."
        role="status"
      >
        <Cloud className="w-3.5 h-3.5" />
        Shared layout on
        <button
          type="button"
          onClick={() => loadSetupFromSheet(selectedCustomerId)}
          className="p-0.5 rounded hover:bg-accent cursor-pointer"
          title="Refresh shared layout from Google Sheet"
          aria-label="Refresh shared layout"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </span>
    );
  }

  return null;
}
