import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, RefreshCw, Wrench } from 'lucide-react';
import { useAppStore, useCustomerDataStatus } from '../stores/useAppStore';
import EnsightLoadingScreen from './EnsightLoadingScreen';

const MotionDiv = motion.div;

/**
 * Blocks the site / level / editor views until the customer's layout has
 * actually been read from the database (MySQL/RDS — see CustomerRepository.js).
 *
 * Rendering before it answers would show either an empty layout or a stale
 * one — both of which look like real data and neither of which is. Worse,
 * editing from that state used to auto-save it back over the real layout.
 * Waiting here is the visible cost of never doing that again — children only
 * ever mounts once status is truly 'ready'. The loader's exit fade (see the
 * design handoff) is done via AnimatePresence unmounting it, not by handing
 * it a toggling isLoading prop — that would mean rendering children before
 * 'ready' just to give the fade something to reveal underneath it.
 */
export default function CustomerDataGate({ children }) {
  const status = useCustomerDataStatus();
  const selectedCustomerId = useAppStore((s) => s.selectedCustomerId);
  const setupSync = useAppStore((s) => s.setupSync);
  const loadCustomerSetup = useAppStore((s) => s.loadCustomerSetup);
  const rebuildSetupFromConfigTabs = useAppStore((s) => s.rebuildSetupFromConfigTabs);

  if (status === 'ready' || status === 'loading') {
    return (
      <AnimatePresence mode="wait">
        {status === 'ready' ? (
          <React.Fragment key="ready">{children}</React.Fragment>
        ) : (
          <MotionDiv key="loading" exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: 'easeOut' }}>
            <EnsightLoadingScreen isLoading />
          </MotionDiv>
        )}
      </AnimatePresence>
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
              This site’s saved layout can’t be read — most likely a save that
              was interrupted before this version shipped. Retrying won’t help.
            </p>
            <p className="text-sm text-muted-foreground">
              You can rebuild it from the config tabs (a Google Sheets import),
              which still hold the sites, levels and devices. Floor-plan images,
              device positions and zones aren’t stored in those tabs, so they’ll
              need re-adding.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            This site’s layout couldn’t be read from the database, so it isn’t
            being shown. Editing is disabled until it loads — that keeps an
            incomplete view from overwriting what’s saved.
          </p>
        )}

        {detail ? (
          <p className="text-xs text-muted-foreground break-words">{detail}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => loadCustomerSetup(selectedCustomerId)}
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
