import React from 'react';
import { useAppStore } from '../stores/useAppStore';
import { customerCanSyncToSheet } from '../lib/customerConfigUtils';
import { Loader2, Cloud, CloudOff, AlertCircle, RefreshCw } from 'lucide-react';

/**
 * Inline status chip for the customer's database persistence (map / devices / zones).
 */
export default function SetupSyncIndicator() {
  const setupSync = useAppStore((s) => s.setupSync);
  const selectedCustomerId = useAppStore((s) => s.selectedCustomerId);
  const customers = useAppStore((s) => s.customers);
  const retrySetupSync = useAppStore((s) => s.retrySetupSync);
  const resolveSetupConflictReload = useAppStore((s) => s.resolveSetupConflictReload);
  const resolveSetupConflictOverwrite = useAppStore((s) => s.resolveSetupConflictOverwrite);
  const loadCustomerSetup = useAppStore((s) => s.loadCustomerSetup);

  const customer = customers.find((c) => c.id === selectedCustomerId) ?? null;
  const canShare = customerCanSyncToSheet(customer);

  if (!selectedCustomerId) return null;

  const { status, error, customerId } = setupSync;
  const isForCustomer = customerId === selectedCustomerId;

  if (isForCustomer && status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading layout…
      </span>
    );
  }

  if (isForCustomer && status === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Saving layout…
      </span>
    );
  }

  if (isForCustomer && status === 'conflict') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300" role="alert">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        <span className="max-w-[220px] truncate" title={error}>{error || 'Save conflict'}</span>
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
        title="Not synced yet — open this site from Drive to bring it into the database."
        role="status"
      >
        <CloudOff className="w-3.5 h-3.5" />
        Not synced
      </span>
    );
  }

  // Saved-time display and the Export to Sheets button are switched off for
  // now — right now the app is purely reading/writing MySQL, so there's
  // nothing sheet-related worth surfacing in the happy-path state. Loading/
  // saving/conflict/error feedback above this is untouched since that's not
  // what was asked to go.
  if (isForCustomer && (status === 'saved' || status === 'loaded')) {
    return null;
  }

  if (canShare) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        title="Map layout, devices, and zones are saved to the database."
        role="status"
      >
        <Cloud className="w-3.5 h-3.5" />
        Synced
        <button
          type="button"
          onClick={() => loadCustomerSetup(selectedCustomerId)}
          className="p-0.5 rounded hover:bg-accent cursor-pointer"
          title="Refresh layout"
          aria-label="Refresh layout"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </span>
    );
  }

  return null;
}
