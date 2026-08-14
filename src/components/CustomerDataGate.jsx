import React from 'react';
import { Loader2, AlertCircle, RefreshCw, Wrench } from 'lucide-react';
import { useAppStore, useCustomerDataStatus } from '../stores/useAppStore';

/**
 * Blocks the site / level / editor views until the customer's layout has
 * actually been read from their Google Sheet.
 *
 * The sheet is the database. Rendering before it answers would show either an
 * empty layout or one derived from the config tabs — both of which look like
 * real data and neither of which is. Worse, editing from that state used to
 * auto-save it back over the real layout. Waiting here is the visible cost of
 * never doing that again.
 */
export default function CustomerDataGate({ children }) {
  const status = useCustomerDataStatus();
  const selectedCustomerId = useAppStore((s) => s.selectedCustomerId);
  const setupSync = useAppStore((s) => s.setupSync);
  const loadSetupFromSheet = useAppStore((s) => s.loadSetupFromSheet);
  const rebuildSetupFromConfigTabs = useAppStore((s) => s.rebuildSetupFromConfigTabs);

  if (status === 'ready') return children;

  if (status === 'nosheet') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" role="alert">
        <div className="max-w-md w-full rounded-lg border border-amber-500/40 bg-amber-500/5 p-6 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <h2 className="font-medium">This site has no Google Sheet yet</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            It’s linked to an Excel file, which the app can read but can’t write
            to. Editing is disabled because nothing would be saved — changes
            would live only in this browser, and nobody else would see them.
          </p>
          <p className="text-sm text-muted-foreground">
            Open this site from Drive to create its Google Sheet. Everything in
            the Excel file is carried across.
          </p>
        </div>
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" role="status">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin" />
          <p className="text-sm">Loading the shared layout from Google Sheets…</p>
        </div>
      </div>
    );
  }

  const isForCustomer = setupSync.customerId === selectedCustomerId;
  const detail = isForCustomer ? setupSync.error : null;
  // Damaged content will never parse, so retrying alone would strand this
  // customer: editing stays blocked until the layout loads.
  const damaged = isForCustomer && setupSync.recoverable;

  return (
    <div className="min-h-screen flex items-center justify-center p-6" role="alert">
      <div className="max-w-md w-full rounded-lg border border-destructive/40 bg-destructive/5 p-6 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <h2 className="font-medium">
            {damaged ? 'The shared layout is damaged' : 'Couldn’t load the shared layout'}
          </h2>
        </div>

        {damaged ? (
          <>
            <p className="text-sm text-muted-foreground">
              The SetupJson tab on this site’s Google Sheet can’t be read — most
              likely a save that was interrupted before this version shipped.
              Retrying won’t help.
            </p>
            <p className="text-sm text-muted-foreground">
              You can rebuild it from the config tabs, which still hold the
              sites, levels and devices. Floor-plan images, device positions and
              zones aren’t stored in those tabs, so they’ll need re-adding.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            This site’s layout lives on its Google Sheet and could not be read,
            so it isn’t being shown. Editing is disabled until it loads — that
            keeps an incomplete view from overwriting what’s on the sheet.
          </p>
        )}

        {detail ? (
          <p className="text-xs text-muted-foreground break-words">{detail}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => loadSetupFromSheet(selectedCustomerId)}
            className="inline-flex items-center gap-1.5 text-sm rounded-md border px-3 py-1.5 hover:bg-accent cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Try again
          </button>
          {damaged ? (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(
                  'Rebuild the shared layout from the config tabs?\n\n'
                  + 'Sites, levels and devices are restored from the sheet tabs. '
                  + 'Floor-plan images, device positions and zones are not stored '
                  + 'there and will need to be re-added.',
                )) {
                  rebuildSetupFromConfigTabs(selectedCustomerId);
                }
              }}
              className="inline-flex items-center gap-1.5 text-sm rounded-md border border-destructive/50 px-3 py-1.5 hover:bg-destructive/10 cursor-pointer"
            >
              <Wrench className="w-3.5 h-3.5" />
              Rebuild from config tabs
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
