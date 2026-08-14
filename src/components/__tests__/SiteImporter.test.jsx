// @vitest-environment jsdom
/**
 * QA — SiteImporter: bringing an .xlsx into the app.
 *
 * Three ways an import can land, and they are not equally forgiving:
 *
 *   new     — creates a customer from the file
 *   merge   — matches sites by name, updates those, adds the rest, keeps the ones
 *             the file does not mention
 *   replace — discards every existing site, level and device
 *
 * `replace` is the only action in the app that throws away a customer's whole
 * layout, and it is reached through two warning gates. Those gates and the
 * merge-vs-replace routing are what these tests hold in place: an import that
 * takes the wrong branch destroys work that is not recoverable from the sheet,
 * because the sheet gets rewritten from the imported state afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const drive = vi.hoisted(() => ({
  isSignedIn: vi.fn(() => true),
  signInWithGoogle: vi.fn(async () => {}),
  listXlsxFiles: vi.fn(async () => ({ files: [], nextPageToken: null })),
  downloadFile: vi.fn(async () => new ArrayBuffer(8)),
}));

const parser = vi.hoisted(() => ({
  parseExcelFile: vi.fn(),
  getImportSummary: vi.fn(),
}));

const sync = vi.hoisted(() => ({
  prepareImportFromDriveFile: vi.fn(async () => ({
    spreadsheetId: 'sheet-new',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-new/edit',
    spreadsheetTitle: 'Acme-config',
    sourceFileId: 'file-1',
    sourceFileName: 'ACME.xlsx',
  })),
  customerSheetQuickLink: (title, url) => ({ id: 1, name: title, url, icon: 'sheets' }),
  loadServersFromNetworkingTab: vi.fn(async () => []),
  loadDisplaySchedulesFromTab: vi.fn(async () => null),
  syncAllConfigTabsForCustomer: vi.fn(async () => ({ changedTabs: [] })),
}));

/**
 * A stand-in SetupJson store, keyed by spreadsheet id. Stateful on purpose: the
 * defect these tests exist for is about what a load finds *after* an import
 * writes, so a mock that always returns the same snapshot would hide it.
 */
const layout = vi.hoisted(() => {
  const setupJson = new Map();
  return {
    __setupJson: setupJson,
    loadCustomerSetupFromSheet: vi.fn(async (customer) => (
      setupJson.get(customer?.spreadsheetId) ?? null
    )),
    readSetupJsonRevision: vi.fn(async (customer) => ({
      savedAt: setupJson.get(customer?.spreadsheetId)?.savedAt ?? null,
      hash: null,
    })),
    serializeCustomerLayout: vi.fn((customer) => ({
      savedAt: '2026-02-02T00:00:00.000Z',
      customer: {
        friendlyName: customer.friendlyName,
        config: customer.config,
        garages: customer.garages,
      },
    })),
    setupContentHash: vi.fn(() => 'hash'),
    writeSetupJsonToSpreadsheet: vi.fn(async (customer, payload) => {
      setupJson.set(customer.spreadsheetId, payload);
    }),
    isSetupContentError: vi.fn(() => false),
  };
});

vi.mock('../../services/LayoutPersistenceService', () => layout);
vi.mock('../../services/GoogleDriveService', () => drive);
vi.mock('../../services/ExcelParserService', () => parser);
vi.mock('../../services/ConfigSheetSyncService', () => sync);

const { useAppStore } = await import('../../stores/useAppStore');
const SiteImporter = (await import('../SiteImporter')).default;

const FILE = {
  id: 'file-1',
  name: 'ACME.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  modifiedTime: '2026-01-02T03:04:05Z',
  size: '2048',
  webViewLink: 'https://drive.google.com/file/d/file-1/view',
};

const site = (name, over = {}) => ({
  id: 1,
  name,
  internalName: name,
  levels: [{ id: 1, name: 'Level 1', devices: [], totalSpots: 0 }],
  quickLinks: [],
  ...over,
});

/** A parse result shaped the way ExcelParserService returns one. */
function parsed(garages, over = {}) {
  return {
    garages,
    sheetNames: ['Customer', 'Garages'],
    rawData: { Customer: [{}], Garages: garages.map(() => ({})), displaySchedules: [] },
    importStats: { skippedDisplayLevelRows: 0 },
    ...over,
  };
}

function setParse(garages, over = {}) {
  const p = parsed(garages, over);
  parser.parseExcelFile.mockReturnValue(p);
  parser.getImportSummary.mockReturnValue({
    totalGarages: garages.length,
    totalLevels: garages.reduce((s, g) => s + g.levels.length, 0),
    totalDevices: 0,
    tabCounts: { Garages: garages.length },
    skippedDisplayLevelRows: over.skipped ?? 0,
  });
  return p;
}

function setStore({ customers = [] } = {}) {
  useAppStore.setState({
    customers,
    selectedCustomerId: null,
    selectedGarageId: null,
    selectedLevelId: null,
    currentView: 'import',
    hydration: {},
    pendingRoute: null,
  });
}

const list = () => useAppStore.getState().customers;
const byId = (id) => list().find((c) => c.id === id);

/** Fields are labelled by a sibling <Label>; scope to the open dialog. */
function field(labelText) {
  const scope = screen.queryByRole('dialog') || document.body;
  for (const label of within(scope).getAllByText(labelText, { exact: false })) {
    const input = label.parentElement?.querySelector('input, textarea');
    if (input) return input;
  }
  throw new Error(`no input for label "${labelText}"`);
}

/**
 * The count above a summary stat label, e.g. stat('Garages') → '2'. Scoped to
 * the stat cards, since the Sheet Data table below repeats the same tab names.
 */
function stat(label) {
  for (const node of within(screen.getByRole('dialog')).getAllByText(label)) {
    if (node.parentElement?.className.includes('flex-col')) {
      return node.previousElementSibling?.textContent;
    }
  }
  throw new Error(`no stat card for "${label}"`);
}

const dialogButton = (name) =>
  within(screen.getByRole('dialog')).getByRole('button', { name });

async function clickInDialog(user, name) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name }));
}

/** File list → Import → the summary dialog. */
async function toSummary(user) {
  await user.click(await screen.findByRole('button', { name: /ACME\.xlsx/ }));
  await user.click(screen.getByRole('button', { name: /^import$/i }));
  await screen.findByText('Import Summary');
}

/** …and on to the conflict dialog, which only appears for a known customer. */
async function toConflict(user) {
  await toSummary(user);
  await clickInDialog(user, /continue/i);
  await screen.findByText('Customer Already Exists');
}

const existingCustomer = (over = {}) => ({
  id: 1,
  customerId: 'acme',
  code: 'ACME',
  friendlyName: 'Acme',
  spreadsheetId: 'sheet-existing',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-existing/edit',
  config: {},
  garages: [site('North Garage', { id: 4 })],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  drive.isSignedIn.mockReturnValue(true);
  drive.listXlsxFiles.mockResolvedValue({ files: [FILE], nextPageToken: null });
  drive.downloadFile.mockResolvedValue(new ArrayBuffer(8));
  // Merge and replace reuse the customer's sheet; only a new customer gets a
  // fresh one. Modelling that is what makes the post-import load realistic.
  sync.prepareImportFromDriveFile.mockImplementation(async ({ existingSpreadsheetId }) => {
    const spreadsheetId = existingSpreadsheetId || 'sheet-new';
    return {
      spreadsheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      spreadsheetTitle: 'Acme-config',
      sourceFileId: 'file-1',
      sourceFileName: 'ACME.xlsx',
    };
  });
  layout.__setupJson.clear();
  // The customer that already exists has a layout on its sheet from before the
  // import — that is the snapshot an import has to survive.
  layout.__setupJson.set('sheet-existing', {
    savedAt: '2026-01-01T00:00:00.000Z',
    customer: {
      friendlyName: 'Acme',
      config: { address: '5 Existing Way', city: 'Denver' },
      garages: [
        { id: 4, name: 'North Garage', internalName: 'North Garage', levels: [], quickLinks: [] },
        { id: 5, name: 'Old Garage', internalName: 'Old Garage', levels: [], quickLinks: [] },
      ],
    },
  });
  setParse([site('North Garage')]);
  setStore();
});
afterEach(cleanup);

// ── FILE LIST ───────────────────────────────────────────────────────────────
describe('the Drive file list', () => {
  it('lists the .xlsx files it finds', async () => {
    render(<SiteImporter />);
    expect(await screen.findByText('ACME.xlsx')).toBeTruthy();
  });

  it('says so when nothing matches', async () => {
    drive.listXlsxFiles.mockResolvedValue({ files: [], nextPageToken: null });
    render(<SiteImporter />);
    expect(await screen.findByText(/No \.xlsx files found/)).toBeTruthy();
  });

  it('asks for sign-in instead of calling Drive while signed out', async () => {
    drive.isSignedIn.mockReturnValue(false);
    render(<SiteImporter />);

    expect(await screen.findByText(/Sign in from the customer list/)).toBeTruthy();
    expect(drive.listXlsxFiles).not.toHaveBeenCalled();
  });

  it('searches after the user stops typing', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);
    await screen.findByText('ACME.xlsx');

    await user.type(screen.getByPlaceholderText('Search files...'), 'acme');

    // Debounced — one request per pause, not one per keystroke.
    await waitFor(
      () => expect(drive.listXlsxFiles).toHaveBeenCalledWith({ searchQuery: 'acme' }),
      { timeout: 2000 },
    );
  });

  it('appends the next page rather than replacing the list', async () => {
    const user = userEvent.setup();
    drive.listXlsxFiles.mockResolvedValueOnce({ files: [FILE], nextPageToken: 'page-2' });
    drive.listXlsxFiles.mockResolvedValueOnce({
      files: [{ ...FILE, id: 'file-2', name: 'BETA.xlsx' }],
      nextPageToken: null,
    });
    render(<SiteImporter />);
    await screen.findByText('ACME.xlsx');

    await user.click(screen.getByRole('button', { name: /load more files/i }));

    expect(await screen.findByText('BETA.xlsx')).toBeTruthy();
    expect(screen.getByText('ACME.xlsx')).toBeTruthy();
  });

  it('offers a re-consent button when Drive refuses the folder', async () => {
    const user = userEvent.setup();
    const denied = Object.assign(new Error('No access to the shared folder'), {
      code: 'DRIVE_FORBIDDEN',
    });
    drive.listXlsxFiles.mockRejectedValueOnce(denied);
    drive.listXlsxFiles.mockResolvedValue({ files: [FILE], nextPageToken: null });
    render(<SiteImporter />);

    await user.click(await screen.findByRole('button', { name: /grant drive access/i }));

    expect(drive.signInWithGoogle).toHaveBeenCalledWith({ prompt: 'consent' });
    expect(await screen.findByText('ACME.xlsx')).toBeTruthy();
  });
});

// ── SUMMARY ─────────────────────────────────────────────────────────────────
describe('the import summary', () => {
  it('downloads, parses and reports what is in the file', async () => {
    const user = userEvent.setup();
    setParse([site('North Garage'), site('South Garage', { id: 2 })]);
    render(<SiteImporter />);

    await toSummary(user);

    expect(drive.downloadFile).toHaveBeenCalledWith('file-1');
    expect(parser.parseExcelFile).toHaveBeenCalled();
    expect(stat('Garages')).toBe('2');
    expect(stat('Levels')).toBe('2');
    expect(stat('Devices')).toBe('0');
  });

  it('prefills the friendly name from the file for an unknown customer', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toSummary(user);

    expect(field('Friendly Name').value).toBe('ACME');
  });

  it('prefills the existing customer’s name when the file matches one', async () => {
    const user = userEvent.setup();
    setStore({ customers: [existingCustomer({ friendlyName: 'Acme Health' })] });
    render(<SiteImporter />);

    await toSummary(user);

    expect(field('Friendly Name').value).toBe('Acme Health');
  });

  it('will not continue without a friendly name', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toSummary(user);
    await user.clear(field('Friendly Name'));

    expect(dialogButton(/continue/i).disabled).toBe(true);
  });

  it('reports a parse failure and opens nothing', async () => {
    const user = userEvent.setup();
    parser.parseExcelFile.mockImplementation(() => {
      throw new Error('Unsupported workbook');
    });
    render(<SiteImporter />);

    await user.click(await screen.findByRole('button', { name: /ACME\.xlsx/ }));
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    expect(await screen.findByText('Unsupported workbook')).toBeTruthy();
    expect(screen.queryByText('Import Summary')).toBeNull();
    expect(list()).toHaveLength(0);
  });

  it('flags display level rows the file could not place', async () => {
    const user = userEvent.setup();
    setParse([site('North Garage')], { skipped: 3 });
    render(<SiteImporter />);

    await toSummary(user);

    expect(screen.getByText(/3 display level rows were skipped/)).toBeTruthy();
  });
});

// ── NEW CUSTOMER ────────────────────────────────────────────────────────────
describe('importing a customer that does not exist yet', () => {
  it('creates it straight from the summary, with no conflict step', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toSummary(user);
    await clickInDialog(user, /continue/i);

    await waitFor(() => expect(list()).toHaveLength(1));
    expect(screen.queryByText('Customer Already Exists')).toBeNull();
    const created = list()[0];
    expect(created.friendlyName).toBe('ACME');
    expect(created.garages.map((g) => g.name)).toEqual(['North Garage']);
  });

  it('records the sheet the import created', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toSummary(user);
    await clickInDialog(user, /continue/i);

    await waitFor(() => expect(list()).toHaveLength(1));
    expect(list()[0].spreadsheetId).toBe('sheet-new');
    expect(list()[0].sourceFileName).toBe('ACME.xlsx');
    // A brand-new customer has no sheet to reuse.
    expect(sync.prepareImportFromDriveFile).toHaveBeenCalledWith(
      expect.objectContaining({ existingSpreadsheetId: null }),
    );
  });

  it('attaches the config sheet link to every imported site', async () => {
    const user = userEvent.setup();
    setParse([site('North Garage'), site('South Garage', { id: 2 })]);
    render(<SiteImporter />);

    await toSummary(user);
    await clickInDialog(user, /continue/i);

    await waitFor(() => expect(list()).toHaveLength(1));
    for (const garage of list()[0].garages) {
      expect(garage.quickLinks.some((l) => l.icon === 'sheets')).toBe(true);
    }
  });

  it('takes the customer address from the first site in the file', async () => {
    const user = userEvent.setup();
    setParse([
      site('North Garage', { address: '100 Main St', city: 'Boston', state: 'MA', zip: '02110' }),
      site('South Garage', { id: 2, address: '900 Elsewhere Ave' }),
    ]);
    render(<SiteImporter />);

    await toSummary(user);
    await clickInDialog(user, /continue/i);

    await waitFor(() => expect(list()).toHaveLength(1));
    expect(list()[0].config.address).toBe('100 Main St');
    expect(list()[0].config.city).toBe('Boston');
  });

  it('opens the customer it just imported', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toSummary(user);
    await clickInDialog(user, /continue/i);

    await waitFor(() => expect(useAppStore.getState().currentView).toBe('garages'));
    expect(useAppStore.getState().selectedCustomerId).toBe(list()[0].id);
  });

  it('uses the name the user typed, not the one from the file', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toSummary(user);
    await user.clear(field('Friendly Name'));
    await user.type(field('Friendly Name'), 'Acme Health Care');
    await clickInDialog(user, /continue/i);

    await waitFor(() => expect(list()).toHaveLength(1));
    expect(list()[0].friendlyName).toBe('Acme Health Care');
  });
});

// ── CONFLICT ROUTING ────────────────────────────────────────────────────────
describe('importing over a customer that already exists', () => {
  beforeEach(() => setStore({ customers: [existingCustomer()] }));

  it('asks how to import rather than choosing for the user', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);

    // Still one customer, still its original site — nothing has happened yet.
    expect(list()).toHaveLength(1);
    expect(byId(1).garages).toHaveLength(1);
    expect(sync.prepareImportFromDriveFile).not.toHaveBeenCalled();
  });

  it('offers both merge and replace', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);

    expect(screen.getByText('Merge / Update')).toBeTruthy();
    expect(screen.getByText('Replace All Sites')).toBeTruthy();
  });

  it('goes back to the summary', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);
    await clickInDialog(user, /back/i);

    expect(await screen.findByText('Import Summary')).toBeTruthy();
  });
});

// ── MERGE ───────────────────────────────────────────────────────────────────
describe('merge', () => {
  beforeEach(() => setStore({ customers: [existingCustomer()] }));

  it('warns first, and changes nothing until the warning is accepted', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Merge / Update'));

    expect(await screen.findByText('Confirm Merge / Update')).toBeTruthy();
    expect(byId(1).garages).toHaveLength(1);
    expect(sync.prepareImportFromDriveFile).not.toHaveBeenCalled();
  });

  it('keeps a site the file does not mention and adds the ones it does', async () => {
    const user = userEvent.setup();
    setStore({
      customers: [existingCustomer({
        garages: [site('North Garage', { id: 4 }), site('Old Garage', { id: 5 })],
      })],
    });
    setParse([site('North Garage'), site('West Garage', { id: 2 })]);
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Merge / Update'));
    await clickInDialog(user, /merge \/ update/i);

    await waitFor(() => expect(byId(1).garages).toHaveLength(3));
    expect(byId(1).garages.map((g) => g.name).sort()).toEqual(
      ['North Garage', 'Old Garage', 'West Garage'],
    );
  });

  it('updates the matching site in place instead of adding a second one', async () => {
    const user = userEvent.setup();
    setParse([site('North Garage', {
      levels: [
        { id: 1, name: 'Level 1', devices: [], totalSpots: 120 },
        { id: 2, name: 'Level 2', devices: [], totalSpots: 80 },
      ],
    })]);
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Merge / Update'));
    await clickInDialog(user, /merge \/ update/i);

    await waitFor(() => expect(byId(1).garages[0].levels).toHaveLength(2));
    expect(byId(1).garages).toHaveLength(1);
  });

  it('writes into the customer’s existing sheet rather than making a second one', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Merge / Update'));
    await clickInDialog(user, /merge \/ update/i);

    await waitFor(() => expect(sync.prepareImportFromDriveFile).toHaveBeenCalled());
    expect(sync.prepareImportFromDriveFile).toHaveBeenCalledWith(
      expect.objectContaining({ existingSpreadsheetId: 'sheet-existing' }),
    );
  });

  it('fills in an address only when the customer has none', async () => {
    const user = userEvent.setup();
    setParse([site('North Garage', { address: '100 Main St', city: 'Boston' })]);
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Merge / Update'));
    await clickInDialog(user, /merge \/ update/i);

    await waitFor(() => expect(byId(1).config?.address).toBe('100 Main St'));
  });

  it('leaves an address the customer already has alone', async () => {
    const user = userEvent.setup();
    setStore({
      customers: [existingCustomer({ config: { address: '5 Existing Way', city: 'Denver' } })],
    });
    setParse([site('North Garage', { address: '100 Main St', city: 'Boston' })]);
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Merge / Update'));
    await clickInDialog(user, /merge \/ update/i);

    await waitFor(() => expect(sync.prepareImportFromDriveFile).toHaveBeenCalled());
    expect(byId(1).config.address).toBe('5 Existing Way');
  });

  it('goes back to the choice without merging', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Merge / Update'));
    await screen.findByText('Confirm Merge / Update');
    await clickInDialog(user, /back/i);

    expect(await screen.findByText('Customer Already Exists')).toBeTruthy();
    expect(sync.prepareImportFromDriveFile).not.toHaveBeenCalled();
  });
});

// ── REPLACE ─────────────────────────────────────────────────────────────────
describe('replace', () => {
  beforeEach(() => setStore({
    customers: [existingCustomer({
      garages: [site('North Garage', { id: 4 }), site('Old Garage', { id: 5 })],
    })],
  }));

  it('does not replace anything at the first warning', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Replace All Sites'));

    expect(await screen.findByText('Replace All Sites?')).toBeTruthy();
    expect(byId(1).garages).toHaveLength(2);
    expect(sync.prepareImportFromDriveFile).not.toHaveBeenCalled();
  });

  it('does not replace anything at the second warning either', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Replace All Sites'));
    await clickInDialog(user, /continue/i);

    expect(await screen.findByText('Are you absolutely sure?')).toBeTruthy();
    expect(byId(1).garages).toHaveLength(2);
    expect(sync.prepareImportFromDriveFile).not.toHaveBeenCalled();
  });

  it('names how many sites are about to be lost', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Replace All Sites'));
    await clickInDialog(user, /continue/i);

    expect(await screen.findByText(/2 site\(s\)/)).toBeTruthy();
  });

  it('backs out of the last gate to the first warning, not to the action', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Replace All Sites'));
    await clickInDialog(user, /continue/i);
    await screen.findByText('Are you absolutely sure?');
    await clickInDialog(user, /back/i);

    expect(await screen.findByText('Replace All Sites?')).toBeTruthy();
    expect(byId(1).garages).toHaveLength(2);
  });

  it('drops every existing site once both gates are passed', async () => {
    const user = userEvent.setup();
    setParse([site('West Garage', { id: 2 })]);
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Replace All Sites'));
    await clickInDialog(user, /continue/i);
    await clickInDialog(user, /replace everything/i);

    await waitFor(() => expect(byId(1).garages).toHaveLength(1));
    expect(byId(1).garages[0].name).toBe('West Garage');
  });

  it('overwrites the customer address too, unlike merge', async () => {
    const user = userEvent.setup();
    setStore({
      customers: [existingCustomer({ config: { address: '5 Existing Way', city: 'Denver' } })],
    });
    setParse([site('West Garage', { id: 2, address: '100 Main St', city: 'Boston' })]);
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Replace All Sites'));
    await clickInDialog(user, /continue/i);
    await clickInDialog(user, /replace everything/i);

    await waitFor(() => expect(byId(1).config.address).toBe('100 Main St'));
  });

  it('writes into the customer’s existing sheet', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Replace All Sites'));
    await clickInDialog(user, /continue/i);
    await clickInDialog(user, /replace everything/i);

    await waitFor(() => expect(sync.prepareImportFromDriveFile).toHaveBeenCalled());
    expect(sync.prepareImportFromDriveFile).toHaveBeenCalledWith(
      expect.objectContaining({ existingSpreadsheetId: 'sheet-existing' }),
    );
  });

  it('leaves the sites in place when the sheet cannot be prepared', async () => {
    const user = userEvent.setup();
    sync.prepareImportFromDriveFile.mockRejectedValue(new Error('Drive quota exceeded'));
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Replace All Sites'));
    await clickInDialog(user, /continue/i);
    await clickInDialog(user, /replace everything/i);

    // The destructive half must not run ahead of the sheet write; otherwise a
    // failed import leaves the customer with nothing and no way back.
    await waitFor(() => expect(screen.getByText('Drive quota exceeded')).toBeTruthy());
    expect(byId(1).garages).toHaveLength(2);
  });
});

// ── HEADER ──────────────────────────────────────────────────────────────────
describe('header', () => {
  it('goes back to the customer list', async () => {
    const user = userEvent.setup();
    render(<SiteImporter />);
    await screen.findByText('ACME.xlsx');

    await user.click(screen.getByTitle('Back to customers'));

    expect(useAppStore.getState().currentView).toBe('customers');
  });
});


// ── WHAT HAPPENS RIGHT AFTER THE IMPORT ─────────────────────────────────────
/**
 * The import finishes by calling `selectCustomer`, which loads the customer's
 * SetupJson from the sheet. For a brand-new customer there is none, so the
 * import stands. For merge and replace there usually IS one — the pre-import
 * layout — and loading it puts the app back exactly where it started.
 *
 * Nothing writes the imported state to the sheet before that load runs, so the
 * import has to survive it. These pin that.
 */
describe('the import survives the load that follows it', () => {
  beforeEach(() => {
    setStore({
      customers: [existingCustomer({
        garages: [site('North Garage', { id: 4 }), site('Old Garage', { id: 5 })],
      })],
    });
  });

  it('a merge is not undone by the pre-import snapshot', async () => {
    const user = userEvent.setup();
    setParse([site('West Garage', { id: 2 })]);
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Merge / Update'));
    await clickInDialog(user, /merge \/ update/i);

    await waitFor(() => expect(byId(1).garages).toHaveLength(3));
    // Let the load that selectCustomer kicked off settle.
    await waitFor(() => expect(useAppStore.getState().hydration[1]).toBeTruthy());
    expect(byId(1).garages.map((g) => g.name)).toContain('West Garage');
  });

  it('a replace is not undone by the pre-import snapshot', async () => {
    const user = userEvent.setup();
    setParse([site('West Garage', { id: 2 })]);
    render(<SiteImporter />);

    await toConflict(user);
    await user.click(screen.getByText('Replace All Sites'));
    await clickInDialog(user, /continue/i);
    await clickInDialog(user, /replace everything/i);

    await waitFor(() => expect(byId(1).garages).toHaveLength(1));
    await waitFor(() => expect(useAppStore.getState().hydration[1]).toBeTruthy());
    expect(byId(1).garages.map((g) => g.name)).toEqual(['West Garage']);
  });
});
