// @vitest-environment jsdom
/**
 * QA — LevelSelector: levels, servers, display groups and sensor groups.
 *
 * Four near-identical add/edit/delete flows, each writing to a different tab.
 * This is where the display-group delete bug lived — a delete that updated the
 * app but left the row on the sheet — so the delete assertions check what was
 * asked of the sync layer, not just that the list shrank.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const sync = vi.hoisted(() => ({
  syncGarageLevelsToSheet: vi.fn(async () => {}),
  syncServersToSheet: vi.fn(async () => {}),
  syncDisplayGroupsToSheet: vi.fn(async () => {}),
  syncSensorGroupsToSheet: vi.fn(async () => {}),
  clearDisplayGroupFromSignsOnSheet: vi.fn(async () => {}),
  syncBulkCamerasToSheet: vi.fn(async (a) => a.devices),
  syncBulkSignsToSheet: vi.fn(async (a) => a.devices),
  syncBulkSensorsToSheet: vi.fn(async (a) => ({ devices: a.devices, garage: a.garage })),
  loadServersFromNetworkingTab: vi.fn(async () => []),
  loadDisplaySchedulesFromTab: vi.fn(async () => []),
  syncAllConfigTabsForCustomer: vi.fn(async () => ({ changedTabs: [] })),
  deviceAfterCameraSync: (d) => d,
}));

vi.mock('../../services/ConfigSheetSyncService', () => sync);
vi.mock('../ContactsSidebar', () => ({ default: () => <div data-testid="contacts" /> }));
vi.mock('../Weather', () => ({ default: () => <div data-testid="weather" /> }));
vi.mock('../CustomerMapDialog', () => ({ default: () => null }));
vi.mock('../ReportIssueDialog', () => ({ default: () => null }));
vi.mock('../AppSettingsDialog', () => ({ default: () => null }));

const { useAppStore } = await import('../../stores/useAppStore');
const LevelSelector = (await import('../LevelSelector')).default;

const CUSTOMER_ID = 1;

function setStore({
  levels = [{ id: 10, name: 'Level 1', internalName: 'Level 1', totalSpots: 100, evSpots: 0, handicapSpots: 0, devices: [], config: {} }],
  servers = [],
  displayGroups = [],
  sensorGroups = [],
  canSync = true,
} = {}) {
  const site = {
    id: 1, name: 'North', internalName: 'North',
    levels, servers, displayGroups, sensorGroups, mdfIdfLocations: [],
    quickLinks: [], contacts: [],
  };
  useAppStore.setState({
    customers: [{
      id: CUSTOMER_ID, customerId: 'acme', code: 'ACME', friendlyName: 'Acme',
      ...(canSync ? { spreadsheetId: 'sheet-1' } : {}),
      sites: [site], config: {},
    }],
    selectedCustomerId: CUSTOMER_ID,
    selectedSiteId: 1,
    selectedLevelId: null,
    currentView: 'levels',
    hydration: { [CUSTOMER_ID]: 'hydrated' },
    pendingRoute: null,
  });
}

const currentSite = () => useAppStore.getState().customers[0].sites[0];

function field(labelText) {
  const label = screen.getByText(labelText);
  const input = label.parentElement?.querySelector('input, textarea');
  if (!input) throw new Error(`no input for label "${labelText}"`);
  return input;
}

/**
 * Number inputs ignore both clear() and select-all under jsdom, so typing
 * appends to the default instead of replacing it. Set the value outright.
 */
function setValue(input, value) {
  fireEvent.change(input, { target: { value } });
}

async function openTab(user, name) {
  await user.click(screen.getByRole('tab', { name }));
}

/** The card for a named row, so its icon-only edit/delete can be reached. */
function cardFor(name) {
  const heading = screen.getByText(name);
  let el = heading;
  for (let i = 0; i < 8 && el; i += 1) {
    if (el.querySelector('svg[class*="trash"]')) return el;
    el = el.parentElement;
  }
  throw new Error(`no delete button found near "${name}"`);
}

/** Icon-only buttons carry no text, so the delete is found by its trash icon. */
async function clickDelete(user, name) {
  const card = cardFor(name);
  const trash = card.querySelector('svg[class*="trash"]');
  await user.click(trash.closest('button'));
}

/**
 * Dialog submits are labelled by the action — "Add Level", "Add Group",
 * "Add Server" — and become "Save" when editing. Scoped to the dialog because
 * the trigger button behind it carries the same text.
 */
async function submit(user, name) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name }));
}

async function confirmDelete(user) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setStore();
});
afterEach(cleanup);

// ── LEVELS ──────────────────────────────────────────────────────────────────
describe('levels', () => {
  it('ADD creates a level and syncs it', async () => {
    const user = userEvent.setup();
    render(<LevelSelector />);

    await user.click(screen.getByRole('button', { name: /add level/i }));
    await user.type(field('Level Name *'), 'Level 2');
    await submit(user, /^add level$/i);

    await waitFor(() => expect(currentSite().levels).toHaveLength(2));
    expect(currentSite().levels.map((l) => l.name)).toContain('Level 2');
    await waitFor(() => expect(sync.syncGarageLevelsToSheet).toHaveBeenCalled());
  });

  it('ADD refuses an empty name', async () => {
    const user = userEvent.setup();
    render(<LevelSelector />);

    await user.click(screen.getByRole('button', { name: /add level/i }));
    await submit(user, /^add level$/i);

    expect(currentSite().levels).toHaveLength(1);
    expect(sync.syncGarageLevelsToSheet).not.toHaveBeenCalled();
  });

  it('ADD carries the spot counts through', async () => {
    const user = userEvent.setup();
    render(<LevelSelector />);

    await user.click(screen.getByRole('button', { name: /add level/i }));
    await user.type(field('Level Name *'), 'Level 3');
    setValue(field('Total Spots'), '250');
    setValue(field('EV Spots'), '8');
    await submit(user, /^add level$/i);

    await waitFor(() => expect(currentSite().levels).toHaveLength(2));
    const added = currentSite().levels.find((l) => l.name === 'Level 3');
    expect(added.totalSpots).toBe(250);
    expect(added.evSpots).toBe(8);
  });

  it('DELETE removes the level and syncs, after confirming', async () => {
    const user = userEvent.setup();
    setStore({
      levels: [
        { id: 10, name: 'Level 1', internalName: 'Level 1', totalSpots: 100, devices: [], config: {} },
        { id: 11, name: 'Level 2', internalName: 'Level 2', totalSpots: 100, devices: [], config: {} },
      ],
    });
    render(<LevelSelector />);

    await clickDelete(user, 'Level 2');
    await confirmDelete(user);

    await waitFor(() => expect(currentSite().levels).toHaveLength(1));
    expect(currentSite().levels[0].name).toBe('Level 1');
    await waitFor(() => expect(sync.syncGarageLevelsToSheet).toHaveBeenCalled());
  });
});

// ── SERVERS ─────────────────────────────────────────────────────────────────
describe('servers', () => {
  it('ADD creates a server and syncs the Networking tab', async () => {
    const user = userEvent.setup();
    render(<LevelSelector />);
    await openTab(user, /servers/i);

    await user.click(screen.getByRole('button', { name: /add server/i }));
    await user.type(field('Server Name *'), 'SRV-1');
    await submit(user, /^add server$/i);

    await waitFor(() => expect(currentSite().servers).toHaveLength(1));
    expect(currentSite().servers[0].name).toBe('SRV-1');
    await waitFor(() => expect(sync.syncServersToSheet).toHaveBeenCalled());
  });

  it('ADD refuses an empty name', async () => {
    const user = userEvent.setup();
    render(<LevelSelector />);
    await openTab(user, /servers/i);

    await user.click(screen.getByRole('button', { name: /add server/i }));
    await submit(user, /^add server$/i);

    expect(currentSite().servers).toHaveLength(0);
    expect(sync.syncServersToSheet).not.toHaveBeenCalled();
  });

  it('DELETE removes the server and syncs', async () => {
    const user = userEvent.setup();
    setStore({ servers: [{ id: 1, name: 'SRV-1', ports: [] }] });
    render(<LevelSelector />);
    await openTab(user, /servers/i);

    await clickDelete(user, 'SRV-1');
    await confirmDelete(user);

    await waitFor(() => expect(currentSite().servers).toHaveLength(0));
    await waitFor(() => expect(sync.syncServersToSheet).toHaveBeenCalled());
  });
});

// ── DISPLAY GROUPS ──────────────────────────────────────────────────────────
describe('display groups', () => {
  it('ADD creates a group and syncs it', async () => {
    const user = userEvent.setup();
    render(<LevelSelector />);
    await openTab(user, /display groups/i);

    await user.click(screen.getByRole('button', { name: /add display group/i }));
    await user.type(field('Group Name *'), 'Entry-Group');
    await submit(user, /^add group$/i);

    await waitFor(() => expect(currentSite().displayGroups).toHaveLength(1));
    expect(currentSite().displayGroups[0].name).toBe('Entry-Group');
    await waitFor(() => expect(sync.syncDisplayGroupsToSheet).toHaveBeenCalled());
  });

  it('ADD carries the force-send seconds through', async () => {
    const user = userEvent.setup();
    render(<LevelSelector />);
    await openTab(user, /display groups/i);

    await user.click(screen.getByRole('button', { name: /add display group/i }));
    await user.type(field('Group Name *'), 'Slow-Group');
    setValue(field('Force Send After (seconds)'), '45');
    await submit(user, /^add group$/i);

    await waitFor(() => expect(currentSite().displayGroups).toHaveLength(1));
    expect(currentSite().displayGroups[0].forceSendAfterSeconds).toBe(45);
  });

  it('DELETE removes the group and gives the sync every site', async () => {
    const user = userEvent.setup();
    setStore({ displayGroups: [{ id: 1, name: 'Entry-Group', forceSendAfterSeconds: 15 }] });
    render(<LevelSelector />);
    await openTab(user, /display groups/i);

    await clickDelete(user, 'Entry-Group');
    await confirmDelete(user);

    await waitFor(() => expect(currentSite().displayGroups).toHaveLength(0));
    await waitFor(() => expect(sync.syncDisplayGroupsToSheet).toHaveBeenCalled());

    // Without every site the sync cannot tell "deleted" from "another site
    // still owns it", and the row survives on the sheet. That was the bug.
    const call = sync.syncDisplayGroupsToSheet.mock.calls.at(-1)[0];
    expect(Array.isArray(call.garages)).toBe(true);
    expect(call.garages.length).toBeGreaterThan(0);
    expect(call.garages[0].displayGroups).toHaveLength(0);
  });

  it('DELETE also unassigns the group from signs on the sheet', async () => {
    const user = userEvent.setup();
    setStore({ displayGroups: [{ id: 1, name: 'Entry-Group' }] });
    render(<LevelSelector />);
    await openTab(user, /display groups/i);

    await clickDelete(user, 'Entry-Group');
    await confirmDelete(user);

    await waitFor(() => expect(sync.clearDisplayGroupFromSignsOnSheet).toHaveBeenCalled());
  });
});

// ── SENSOR GROUPS ───────────────────────────────────────────────────────────
describe('sensor groups', () => {
  it('ADD creates a group and syncs it', async () => {
    const user = userEvent.setup();
    render(<LevelSelector />);
    await openTab(user, /sensor groups/i);

    await user.click(screen.getByRole('button', { name: /add sensor group/i }));
    await user.type(field('Group ID *'), 'NWAVE-1');
    await submit(user, /^add group$/i);

    await waitFor(() => expect(currentSite().sensorGroups).toHaveLength(1));
    expect(currentSite().sensorGroups[0].groupId).toBe('NWAVE-1');
    await waitFor(() => expect(sync.syncSensorGroupsToSheet).toHaveBeenCalled());
  });

  it('ADD carries the controller address and key through', async () => {
    const user = userEvent.setup();
    render(<LevelSelector />);
    await openTab(user, /sensor groups/i);

    await user.click(screen.getByRole('button', { name: /add sensor group/i }));
    await user.type(field('Group ID *'), 'NWAVE-2');
    await user.type(field('Controller Address'), '10.0.0.77');
    await user.type(field('Controller Key'), 'key-abc');
    await submit(user, /^add group$/i);

    await waitFor(() => expect(currentSite().sensorGroups).toHaveLength(1));
    const group = currentSite().sensorGroups[0];
    expect(group.controllerAddress).toBe('10.0.0.77');
    expect(group.controllerKey).toBe('key-abc');
  });

  it('DELETE removes the group and syncs', async () => {
    const user = userEvent.setup();
    setStore({ sensorGroups: [{ id: 1, groupId: 'NWAVE-1', sensorProtocol: 'NWAVE' }] });
    render(<LevelSelector />);
    await openTab(user, /sensor groups/i);

    await clickDelete(user, 'NWAVE-1');
    await confirmDelete(user);

    await waitFor(() => expect(currentSite().sensorGroups).toHaveLength(0));
    await waitFor(() => expect(sync.syncSensorGroupsToSheet).toHaveBeenCalled());
  });
});

// ── FAILURE SURFACING ───────────────────────────────────────────────────────
describe('when the sheet sync fails', () => {
  it('says so rather than pretending the level was saved', async () => {
    const user = userEvent.setup();
    sync.syncGarageLevelsToSheet.mockRejectedValueOnce(new Error('Sheets rate limit reached'));
    render(<LevelSelector />);

    await user.click(screen.getByRole('button', { name: /add level/i }));
    await user.type(field('Level Name *'), 'Level 2');
    await submit(user, /^add level$/i);

    await waitFor(() => expect(screen.getByText(/rate limit/i)).toBeTruthy());
  });

  it('says so when a display group cannot be synced', async () => {
    const user = userEvent.setup();
    sync.syncDisplayGroupsToSheet.mockRejectedValueOnce(new Error('Sheets rate limit reached'));
    render(<LevelSelector />);
    await openTab(user, /display groups/i);

    await user.click(screen.getByRole('button', { name: /add display group/i }));
    await user.type(field('Group Name *'), 'G');
    await submit(user, /^add group$/i);

    await waitFor(() => expect(screen.getByText(/rate limit/i)).toBeTruthy());
  });
});

// ── NO WRITABLE SHEET ───────────────────────────────────────────────────────
describe('a customer with no writable sheet', () => {
  it('does not attempt a sync when adding a level', async () => {
    const user = userEvent.setup();
    setStore({ canSync: false });
    render(<LevelSelector />);

    await user.click(screen.getByRole('button', { name: /add level/i }));
    await user.type(field('Level Name *'), 'Level 2');
    await submit(user, /^add level$/i);

    await waitFor(() => expect(currentSite().levels).toHaveLength(2));
    expect(sync.syncGarageLevelsToSheet).not.toHaveBeenCalled();
  });
});
