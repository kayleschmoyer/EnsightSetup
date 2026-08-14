// @vitest-environment jsdom
/**
 * QA — SetupSyncIndicator: the chip you press on a bad day.
 *
 * Every other screen is a write path. This one is a recovery path, and it owns
 * the only two buttons in the app that decide whose work survives a collision:
 *
 *   Reload    — discard what is in this browser, take the sheet's version
 *   Overwrite — force this browser's version over someone else's newer save
 *
 * Getting these backwards loses a colleague's edits with one click and no
 * second prompt, so the tests assert on what actually lands on the sheet, not
 * on which store action was called. The SetupJson mock is stateful for that
 * reason — a spy would pass either way round.
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
    readSetupJsonRevision: vi.fn(async (customer) => {
      const snap = setupJson.get(customer?.spreadsheetId);
      return { savedAt: snap?.savedAt ?? null, hash: snap?.hash ?? null };
    }),
    serializeCustomerLayout: vi.fn((customer) => ({
      savedAt: '2026-03-03T00:00:00.000Z',
      customer: {
        friendlyName: customer.friendlyName,
        config: customer.config,
        garages: customer.garages,
      },
    })),
    setupContentHash: vi.fn((payload) => JSON.stringify(payload.customer.garages)),
    writeSetupJsonToSpreadsheet: vi.fn(async (customer, payload) => {
      setupJson.set(customer.spreadsheetId, {
        ...payload,
        hash: JSON.stringify(payload.customer.garages),
      });
    }),
    isSetupContentError: vi.fn(() => false),
  };
});

const sync = vi.hoisted(() => ({
  loadServersFromNetworkingTab: vi.fn(async () => []),
  loadDisplaySchedulesFromTab: vi.fn(async () => null),
  syncAllConfigTabsForCustomer: vi.fn(async () => ({ changedTabs: [] })),
}));

vi.mock('../../services/LayoutPersistenceService', () => layout);
vi.mock('../../services/ConfigSheetSyncService', () => sync);
vi.mock('../../services/GoogleDriveService', () => ({
  downloadConfigFile: vi.fn(async () => new ArrayBuffer(8)),
}));
vi.mock('../../services/ExcelParserService', () => ({
  parseExcelFile: vi.fn(() => ({ garages: [] })),
}));

const { useAppStore } = await import('../../stores/useAppStore');
const SetupSyncIndicator = (await import('../SetupSyncIndicator')).default;

const garage = (name) => ({
  id: 1, name, internalName: name, levels: [], quickLinks: [],
});

const customer = (over = {}) => ({
  id: 1,
  customerId: 'acme',
  friendlyName: 'Acme',
  spreadsheetId: 'sheet-1',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
  config: {},
  garages: [garage('Mine')],
  lastSetupSavedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function setStore({ customers = [customer()], setupSync = {}, hydration = { 1: 'hydrated' } } = {}) {
  useAppStore.setState({
    customers,
    selectedCustomerId: 1,
    selectedGarageId: null,
    selectedLevelId: null,
    currentView: 'editor',
    hydration,
    pendingRoute: null,
    setupSync: { status: 'idle', error: null, savedAt: null, customerId: 1, ...setupSync },
  });
}

const localGarages = () => useAppStore.getState().customers[0].garages.map((g) => g.name);
const sheetGarages = () =>
  layout.__setupJson.get('sheet-1')?.customer.garages.map((g) => g.name) ?? null;

/** Someone else's newer layout, already sitting on the sheet. */
function seedRemote(names, savedAt = '2026-02-02T00:00:00.000Z') {
  const garages = names.map((n, i) => ({ ...garage(n), id: i + 10 }));
  layout.__setupJson.set('sheet-1', {
    savedAt,
    hash: JSON.stringify(garages),
    customer: { friendlyName: 'Acme', config: {}, garages },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  layout.__setupJson.clear();
  setStore();
});
afterEach(cleanup);

// ── STATUS ──────────────────────────────────────────────────────────────────
describe('what the chip says', () => {
  it('shows nothing when no customer is open', () => {
    setStore({ customers: [customer()] });
    useAppStore.setState({ selectedCustomerId: null });
    const { container } = render(<SetupSyncIndicator />);
    expect(container.textContent).toBe('');
  });

  it('reports a load in progress', () => {
    setStore({ setupSync: { status: 'loading' } });
    render(<SetupSyncIndicator />);
    expect(screen.getByText(/Loading shared layout/)).toBeTruthy();
  });

  it('reports a save in progress', () => {
    setStore({ setupSync: { status: 'saving' } });
    render(<SetupSyncIndicator />);
    expect(screen.getByText(/Saving shared layout/)).toBeTruthy();
  });

  it('reports a customer with no writable sheet', () => {
    setStore({ setupSync: { status: 'unavailable' } });
    render(<SetupSyncIndicator />);
    expect(screen.getByText('Needs a Google Sheet')).toBeTruthy();
  });

  it('falls back to the idle state for a sheet-backed customer', () => {
    render(<SetupSyncIndicator />);
    expect(screen.getByText('Shared layout on')).toBeTruthy();
  });

  it('shows nothing at all for a customer that cannot sync', () => {
    setStore({ customers: [customer({ spreadsheetId: null, sourceFileId: 'xlsx-1' })] });
    const { container } = render(<SetupSyncIndicator />);
    expect(container.textContent).toBe('');
  });

  it('ignores a status belonging to a different customer', () => {
    setStore({ setupSync: { status: 'conflict', customerId: 99 } });
    render(<SetupSyncIndicator />);

    // Another customer's conflict must not offer Overwrite on this one.
    expect(screen.queryByRole('button', { name: 'Overwrite' })).toBeNull();
    expect(screen.getByText('Shared layout on')).toBeTruthy();
  });
});

// ── CONFLICT ────────────────────────────────────────────────────────────────
describe('a conflict', () => {
  beforeEach(() => {
    seedRemote(['Theirs']);
    setStore({
      setupSync: {
        status: 'conflict',
        error: 'Someone else saved a newer shared setup.',
        remoteSavedAt: '2026-02-02T00:00:00.000Z',
      },
    });
  });

  it('offers both ways out, and says which one it is', () => {
    render(<SetupSyncIndicator />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Someone else saved a newer shared setup/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeTruthy();
  });

  it('Reload takes their version and drops mine', async () => {
    const user = userEvent.setup();
    render(<SetupSyncIndicator />);
    expect(localGarages()).toEqual(['Mine']);

    await user.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(localGarages()).toEqual(['Theirs']));
    // And it must not write on the way — reloading is not a save.
    expect(layout.writeSetupJsonToSpreadsheet).not.toHaveBeenCalled();
    expect(sheetGarages()).toEqual(['Theirs']);
  });

  it('Overwrite puts mine on the sheet, over theirs', async () => {
    const user = userEvent.setup();
    render(<SetupSyncIndicator />);

    await user.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(sheetGarages()).toEqual(['Mine']));
    expect(localGarages()).toEqual(['Mine']);
  });

  it('Overwrite does not stall on the same conflict it is resolving', async () => {
    const user = userEvent.setup();
    render(<SetupSyncIndicator />);

    await user.click(screen.getByRole('button', { name: 'Overwrite' }));

    // Forced, so the remote-is-newer check that raised the conflict is skipped
    // rather than raising it again and leaving the user with a dead button.
    await waitFor(() => expect(useAppStore.getState().setupSync.status).toBe('saved'));
  });

  it('leaves the conflict standing until one of them is pressed', () => {
    render(<SetupSyncIndicator />);

    expect(useAppStore.getState().setupSync.status).toBe('conflict');
    expect(layout.writeSetupJsonToSpreadsheet).not.toHaveBeenCalled();
    expect(localGarages()).toEqual(['Mine']);
  });
});

// ── ERROR AND RETRY ─────────────────────────────────────────────────────────
describe('an error', () => {
  it('shows the message and a Retry', () => {
    setStore({ setupSync: { status: 'error', error: 'Network unreachable' } });
    render(<SetupSyncIndicator />);

    expect(screen.getByText('Network unreachable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('Retry after a failed load reads again rather than writing', async () => {
    const user = userEvent.setup();
    seedRemote(['Theirs']);
    setStore({
      setupSync: { status: 'error', action: 'load', error: 'Read failed' },
      hydration: { 1: 'failed' },
    });
    render(<SetupSyncIndicator />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(localGarages()).toEqual(['Theirs']));
    // Retrying a read must never turn into a write — that is the failure that
    // used to put an unloaded layout on the sheet.
    expect(layout.writeSetupJsonToSpreadsheet).not.toHaveBeenCalled();
  });

  it('Retry after a failed save writes again', async () => {
    const user = userEvent.setup();
    setStore({ setupSync: { status: 'error', action: 'save', error: 'Write failed' } });
    render(<SetupSyncIndicator />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(sheetGarages()).toEqual(['Mine']));
  });

  it('Retry on an unhydrated customer still refuses to write', async () => {
    const user = userEvent.setup();
    setStore({
      setupSync: { status: 'error', action: 'save', error: 'Write failed' },
      hydration: { 1: 'failed' },
    });
    render(<SetupSyncIndicator />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(useAppStore.getState().setupSync.status).toBe('error'));
    expect(layout.writeSetupJsonToSpreadsheet).not.toHaveBeenCalled();
    expect(sheetGarages()).toBeNull();
  });
});

// ── REFRESH ─────────────────────────────────────────────────────────────────
describe('the refresh button', () => {
  it('pulls the sheet’s current layout', async () => {
    const user = userEvent.setup();
    seedRemote(['Theirs']);
    render(<SetupSyncIndicator />);

    await user.click(screen.getByRole('button', { name: 'Refresh shared layout' }));

    await waitFor(() => expect(localGarages()).toEqual(['Theirs']));
  });

  it('is offered on the synced state too, with the time it saved', async () => {
    const user = userEvent.setup();
    seedRemote(['Theirs']);
    setStore({ setupSync: { status: 'saved', savedAt: '2026-02-02T15:04:00.000Z' } });
    render(<SetupSyncIndicator />);

    expect(screen.getByText(/Shared layout/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Refresh shared layout' }));

    await waitFor(() => expect(localGarages()).toEqual(['Theirs']));
  });
});
