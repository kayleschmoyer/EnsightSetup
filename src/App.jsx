import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppStore, useCustomerSites, useLevels } from './stores/useAppStore';
import CustomerDataGate from './components/CustomerDataGate';
import { TooltipProvider } from './components/ui/tooltip';
import CustomerSelector from './components/CustomerSelector';
import SiteSelector from './components/SiteSelector';
import LevelSelector from './components/LevelSelector';
import EditorView from './components/EditorView';
import WriteConfirmationDialog from './components/WriteConfirmationDialog';
import { getSession, onAuthStateChange } from './services/GoogleAuthService';
import { subscribeToCustomersTable } from './services/CustomerRepository';
import './App.css';

const MotionDiv = motion.div;

// Legacy context export for backward compatibility
export const AppContext = React.createContext();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 2,
    },
  },
});

const viewComponents = {
  customers: CustomerSelector,
  sites: SiteSelector,
  levels: LevelSelector,
  editor: EditorView,
};

function AppContent() {
  const currentView = useAppStore(s => s.currentView);
  const mode = useAppStore(s => s.mode);
  const customers = useAppStore(s => s.customers);
  const selectedCustomerId = useAppStore(s => s.selectedCustomerId);
  const selectedSiteId = useAppStore(s => s.selectedSiteId);
  const selectedLevelId = useAppStore(s => s.selectedLevelId);
  const selectedDevice = useAppStore(s => s.selectedDevice);
  const setSites = useAppStore(s => s.setSites);
  const setSelectedCustomerId = useAppStore(s => s.setSelectedCustomerId);
  const selectCustomer = useAppStore(s => s.selectCustomer);
  const setSelectedSiteId = useAppStore(s => s.setSelectedSiteId);
  const selectSite = useAppStore(s => s.selectSite);
  const setLevels = useAppStore(s => s.setLevels);
  const setSelectedLevelId = useAppStore(s => s.setSelectedLevelId);
  const selectLevel = useAppStore(s => s.selectLevel);
  const setSelectedDevice = useAppStore(s => s.setSelectedDevice);
  const setCurrentView = useAppStore(s => s.setCurrentView);
  const goBack = useAppStore(s => s.goBack);
  const sites = useCustomerSites();
  const levels = useLevels();

  // Dark mode only now — light mode was removed, so this just applies the
  // class once rather than reacting to a value that can no longer change.
  useEffect(() => {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
  }, []);

  // The app session (Google OAuth, ensight-technologies.com only — see
  // GoogleAuthService.js) drives everything: once signed in, pull the
  // customer list; on sign-out, drop it — customers exist only in memory, so
  // a signed-out browser shows nothing. Runs once at mount (in case a session
  // already exists from a previous visit) and again on every sign-in/sign-out.
  useEffect(() => {
    const store = useAppStore.getState();
    const syncSession = (session) => {
      const hadSession = Boolean(useAppStore.getState().session);
      store.setSession(session);
      if (session) {
        store.loadCustomersFromSupabase();
      } else if (hadSession) {
        store.clearAllCustomers();
      }
    };
    getSession().then(syncSession);
    return onAuthStateChange(syncSession);
  }, []);

  // Live updates: while signed in, listen for customers-row changes (any tab,
  // any user) and let the store re-fetch what changed. Boolean dep so token
  // refreshes don't churn the websocket subscription.
  const signedIn = useAppStore((s) => Boolean(s.session));
  useEffect(() => {
    if (!signedIn) return undefined;
    return subscribeToCustomersTable((payload) => {
      useAppStore.getState().handleRemoteCustomerEvent(payload);
    });
  }, [signedIn]);

  useEffect(() => {
    useAppStore.getState().parseUrlAndRestore();
    const handler = () => useAppStore.getState().handlePopState();
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  // Mouse side buttons (X1=Back button 3, X2=Forward button 4).
  // Chrome often steals these for horizontal overscroll when a region has
  // overflow-x; block that and drive SPA history instead. Use auxclick (the
  // spec'd non-primary click) with mouseup as a fallback, once per gesture.
  useEffect(() => {
    let gestureHandled = false;

    const isSideButton = (e) => e.button === 3 || e.button === 4;

    const onMouseDown = (e) => {
      if (!isSideButton(e)) return;
      gestureHandled = false;
      // Prevent autoscroll / overscroll so the click reaches auxclick/mouseup.
      e.preventDefault();
    };

    const navigateSideButton = (e) => {
      if (!isSideButton(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (gestureHandled) return;
      gestureHandled = true;
      if (e.button === 3) {
        window.history.back();
      } else {
        window.history.forward();
      }
    };

    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', navigateSideButton, true);
    window.addEventListener('auxclick', navigateSideButton, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', navigateSideButton, true);
      window.removeEventListener('auxclick', navigateSideButton, true);
    };
  }, []);

  // Re-resolve the route only when the customer list goes from empty to
  // populated — the mount effect above already ran, and re-resolving on every
  // add or removal re-issued the sheet reads each time.
  const previousCustomerCount = React.useRef(customers.length);
  useEffect(() => {
    const wasEmpty = previousCustomerCount.current === 0;
    previousCustomerCount.current = customers.length;
    if (!wasEmpty || customers.length === 0) return;
    useAppStore.getState().parseUrlAndRestore();
  }, [customers.length]);

  useEffect(() => {
    const store = useAppStore.getState();
    if (['sites', 'levels', 'editor'].includes(currentView) && !selectedCustomerId) {
      store.resetNavigation();
      return;
    }
    // A deep link parks on 'sites' with the site/level slugs still pending
    // until the sheet answers. Correcting navigation now would discard them.
    if (store.pendingRoute) return;
    if (currentView === 'editor' && (!selectedSiteId || !selectedLevelId)) {
      if (selectedSiteId) {
        store.setCurrentView('levels');
        store.updateUrl(selectedCustomerId, selectedSiteId, null, { replace: true });
      } else {
        store.setCurrentView('sites');
        store.updateUrl(selectedCustomerId, null, null, { replace: true });
      }
      return;
    }
    if (currentView === 'levels' && !selectedSiteId) {
      store.setCurrentView('sites');
      store.updateUrl(selectedCustomerId, null, null, { replace: true });
    }
  }, [currentView, selectedCustomerId, selectedSiteId, selectedLevelId]);

  const CurrentView = viewComponents[currentView] || CustomerSelector;

  const currentCustomer = customers.find(c => c.id === selectedCustomerId) ?? null;
  const currentLevel = levels.find(l => l.id === selectedLevelId) ?? null;

  // Build legacy context value for backward compatibility
  const contextValue = {
    customers,
    currentCustomer,
    sites,
    setSites,
    selectedCustomerId,
    setSelectedCustomerId,
    selectCustomer,
    selectedSiteId,
    setSelectedSiteId,
    selectSite,
    levels,
    setLevels,
    selectedLevelId,
    setSelectedLevelId,
    selectLevel,
    currentLevel,
    selectedDevice,
    setSelectedDevice,
    currentView,
    setCurrentView,
    goBack,
    mode,
  };

  return (
    <AppContext.Provider value={contextValue}>
      <div className="min-h-screen bg-background text-foreground">
        <WriteConfirmationDialog />
        <AnimatePresence mode="wait">
          <MotionDiv
            key={currentView}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="min-h-screen"
          >
            {currentView === 'customers' ? (
              <CurrentView />
            ) : (
              <CustomerDataGate>
                <CurrentView />
              </CustomerDataGate>
            )}
          </MotionDiv>
        </AnimatePresence>
      </div>
    </AppContext.Provider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
