// @vitest-environment jsdom
/**
 * QA — CustomerDataGate: what stands between a failed read and the editor.
 *
 * This is the visible half of the rule that stopped the data loss: never render
 * a layout that was not read from the sheet, because editing from that state
 * used to auto-save it back over the real one. The store side of that is
 * covered by useAppStore.dataLoss; what is tested here is the screen — that it
 * actually blocks, that it distinguishes "could not read" from "damaged beyond
 * reading", and that the way out of each is offered.
 *
 * The gate rendering children when it should not is the same bug as before,
 * one layer up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const layout = vi.hoisted(() => {
  const setupJson = new Map();
  return {
    __setupJson: setupJson,
    loadCustomerSetupFromSheet: vi.fn(async (customer) => (
      setupJson.get(customer?.spreadsheetId) ?? null
    )),
    readSetupJsonRevision: vi.fn(async () => ({ savedAt: null, hash: null })),
    serializeCustomerLayout: vi.fn((customer) => ({
      savedAt: '2026-03-03T00:00:00.000Z',
      customer: {
        friendlyName: customer.friendlyName,
        config: customer.config,
        sites: customer.sites,
      },
    })),
    setupContentHash: vi.fn(() => 'hash'),
    writeSetupJsonToSpreadsheet: vi.fn(async (customer, payload) => {
      setupJson.set(customer.spreadsheetId, payload);
    }),
    isSetupContentError: vi.fn(() => false),
  };
});

const sync = vi.hoisted(() => ({
  loadServersFromNetworkingTab: vi.fn(async () => []),
  loadDisplaySchedulesFromTab: vi.fn(async () => null),
  syncAllConfigTabsForCustomer: vi.fn(async () => ({ changedTabs: [] })),
}));

const drive = vi.hoisted(() => ({ downloadConfigFile: vi.fn(async () => new ArrayBuffer(8)) }));
const parser = vi.hoisted(() => ({
  parseExcelFile: vi.fn(() => ({
    sites: [{ id: 7, name: 'Rebuilt', internalName: 'Rebuilt', levels: [], quickLinks: [] }],
  })),
}));

vi.mock('../../services/LayoutPersistenceService', () => layout);
vi.mock('../../services/ConfigSheetSyncService', () => sync);
vi.mock('../../services/GoogleDriveService', () => drive);
vi.mock('../../services/ExcelParserService', () => parser);

const { useAppStore } = await import('../../stores/useAppStore');
const CustomerDataGate = (await import('../CustomerDataGate')).default;

const CHILD = <div data-testid="editor">the editor</div>;

const customer = (over = {}) => ({
  id: 1,
  customerId: 'acme',
  friendlyName: 'Acme',
  spreadsheetId: 'sheet-1',
  config: {},
  sites: null,
  ...over,
});

function setStore({ customers = [customer()], hydration = {}, setupSync = {} } = {}) {
  useAppStore.setState({
    customers,
    selectedCustomerId: 1,
    selectedSiteId: null,
    selectedLevelId: null,
    currentView: 'editor',
    hydration,
    pendingRoute: null,
    setupSync: { status: 'idle', error: null, savedAt: null, customerId: 1, ...setupSync },
  });
}

const shown = () => screen.queryByTestId('editor');
const localSites = () => useAppStore.getState().customers[0].sites?.map((s) => s.name) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  layout.__setupJson.clear();
  setStore();
});
afterEach(cleanup);

// ── WHEN IT LETS YOU THROUGH ────────────────────────────────────────────────
describe('when the layout has been read', () => {
  it('renders the app once the customer is hydrated', () => {
    setStore({ hydration: { 1: 'hydrated' } });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);
    expect(shown()).toBeTruthy();
  });

  it('renders the app when the sheet genuinely has no layout yet', () => {
    // 'absent' is a successful read that found nothing — a legitimate starting
    // state, and the only reason a first save is allowed.
    setStore({ hydration: { 1: 'absent' } });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);
    expect(shown()).toBeTruthy();
  });

  it('renders the app when no customer is selected at all', () => {
    setStore();
    useAppStore.setState({ selectedCustomerId: null });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);
    expect(shown()).toBeTruthy();
  });

  it('leaves a local customer with no linked file alone', () => {
    // Nothing to disagree with — there is no second copy of this one.
    setStore({ customers: [customer({ spreadsheetId: null, sourceFileId: null })] });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);
    expect(shown()).toBeTruthy();
  });
});

// ── WHEN IT BLOCKS ──────────────────────────────────────────────────────────
describe('when the layout has not been read', () => {
  it('blocks with a spinner while the read is in flight', () => {
    setStore({ hydration: { 1: 'loading' } });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    expect(shown()).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText(/Loading the shared layout/)).toBeTruthy();
  });

  it('blocks before the read has even started', () => {
    // Unknown is not the same as absent. Rendering here would show `sites:
    // null` as an empty layout, which is the state that used to get saved.
    setStore({ hydration: {} });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);
    expect(shown()).toBeNull();
  });

  it('blocks with an error when the read failed', () => {
    setStore({ hydration: { 1: 'failed' } });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    expect(shown()).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Couldn’t load the shared layout/)).toBeTruthy();
  });

  it('shows the underlying reason when there is one', () => {
    setStore({
      hydration: { 1: 'failed' },
      setupSync: { status: 'error', action: 'load', error: 'Rate limit exceeded' },
    });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    expect(screen.getByText('Rate limit exceeded')).toBeTruthy();
  });

  it('does not borrow another customer’s error message', () => {
    setStore({
      hydration: { 1: 'failed' },
      setupSync: { status: 'error', action: 'load', error: 'Rate limit exceeded', customerId: 99 },
    });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    expect(screen.queryByText('Rate limit exceeded')).toBeNull();
  });
});

// ── XLSX-ONLY ───────────────────────────────────────────────────────────────
describe('a customer linked to an .xlsx but no Google Sheet', () => {
  beforeEach(() => setStore({
    customers: [customer({ spreadsheetId: null, sourceFileId: 'xlsx-1', sites: [] })],
  }));

  it('blocks editing, because nothing would be saved', () => {
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    expect(shown()).toBeNull();
    expect(screen.getByText(/no Google Sheet yet/)).toBeTruthy();
  });

  it('says how to fix it rather than offering a dead retry', () => {
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    expect(screen.getByText(/Open this site from Drive/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });
});

// ── RETRY ───────────────────────────────────────────────────────────────────
describe('Try again', () => {
  it('reads the sheet and lets the app through when it works', async () => {
    const user = userEvent.setup();
    layout.__setupJson.set('sheet-1', {
      savedAt: '2026-02-02T00:00:00.000Z',
      customer: {
        friendlyName: 'Acme',
        config: {},
        sites: [{ id: 3, name: 'North', internalName: 'North', levels: [], quickLinks: [] }],
      },
    });
    setStore({ hydration: { 1: 'failed' } });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(shown()).toBeTruthy());
    expect(localSites()).toEqual(['North']);
  });

  it('stays blocked when the read fails again', async () => {
    const user = userEvent.setup();
    layout.loadCustomerSetupFromSheet.mockRejectedValue(new Error('Still unreachable'));
    setStore({ hydration: { 1: 'failed' } });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByText('Still unreachable')).toBeTruthy());
    expect(shown()).toBeNull();
    expect(layout.writeSetupJsonToSpreadsheet).not.toHaveBeenCalled();
  });
});

// ── DAMAGED LAYOUT ──────────────────────────────────────────────────────────
describe('a SetupJson tab that will never parse', () => {
  const damaged = {
    hydration: { 1: 'failed' },
    setupSync: {
      status: 'error',
      action: 'load',
      error: 'SetupJson tab is incomplete (2 of 5 chunks)',
      recoverable: true,
    },
  };

  it('says it is damaged rather than blaming the network', () => {
    setStore(damaged);
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    expect(screen.getByText(/The shared layout is damaged/)).toBeTruthy();
    expect(screen.getByText(/Retrying won’t help/)).toBeTruthy();
  });

  it('offers the rebuild, which an ordinary failure does not', () => {
    setStore(damaged);
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);
    expect(screen.getByRole('button', { name: /rebuild from config tabs/i })).toBeTruthy();

    cleanup();
    setStore({ hydration: { 1: 'failed' } });
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);
    expect(screen.queryByRole('button', { name: /rebuild from config tabs/i })).toBeNull();
  });

  it('warns what the rebuild cannot bring back, and does nothing if declined', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    setStore(damaged);
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    await user.click(screen.getByRole('button', { name: /rebuild from config tabs/i }));

    expect(confirm.mock.calls[0][0]).toMatch(/Floor-plan images, device positions and zones/);
    expect(drive.downloadConfigFile).not.toHaveBeenCalled();
    expect(shown()).toBeNull();
    confirm.mockRestore();
  });

  it('rebuilds from the config tabs and lets the app through once confirmed', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setStore(damaged);
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    await user.click(screen.getByRole('button', { name: /rebuild from config tabs/i }));

    await waitFor(() => expect(localSites()).toEqual(['Rebuilt']));
    await waitFor(() => expect(shown()).toBeTruthy());
    confirm.mockRestore();
  });

  it('replaces the damaged tab so the next load is not stuck too', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setStore(damaged);
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    await user.click(screen.getByRole('button', { name: /rebuild from config tabs/i }));

    await waitFor(() => expect(layout.writeSetupJsonToSpreadsheet).toHaveBeenCalled());
    expect(layout.__setupJson.get('sheet-1')?.customer.sites.map((s) => s.name))
      .toEqual(['Rebuilt']);
    confirm.mockRestore();
  });

  it('stays blocked when the rebuild itself fails', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    drive.downloadConfigFile.mockRejectedValue(new Error('Config file unreadable'));
    setStore(damaged);
    render(<CustomerDataGate>{CHILD}</CustomerDataGate>);

    await user.click(screen.getByRole('button', { name: /rebuild from config tabs/i }));

    await waitFor(() => expect(screen.getByText('Config file unreadable')).toBeTruthy());
    expect(shown()).toBeNull();
    confirm.mockRestore();
  });
});
