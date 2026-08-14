// @vitest-environment jsdom
/**
 * QA — CustomerSelector: create, rename and remove customers.
 *
 * The only screen that creates and renames files on Drive, so its failure modes
 * are about keeping Drive, the catalog and local state in agreement. A rename
 * touches three things — the Sheet's file name, the companion .xlsx's file name,
 * and the Customer tab — and each can fail independently. What the app must
 * never do is claim a rename happened that Drive rejected, or lose the user's
 * typing because one of the later steps failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const drive = vi.hoisted(() => ({
  isSignedIn: vi.fn(() => true),
  hadGoogleSession: vi.fn(() => true),
  signInWithGoogle: vi.fn(async () => {}),
  signOut: vi.fn(),
  verifySharedFolderAccess: vi.fn(async () => true),
  listAllConfigFilesInFolder: vi.fn(async () => []),
  subscribeGoogleAuth: vi.fn(() => () => {}),
  renameDriveFile: vi.fn(async () => ({})),
  publishGoogleAuthState: vi.fn(),
}));

const sync = vi.hoisted(() => ({
  assertConfigSheetNameAvailable: vi.fn(async () => {}),
  createCustomerConfigSheet: vi.fn(async ({ friendlyName }) => ({
    spreadsheetId: 'sheet-new',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-new/edit',
    spreadsheetTitle: `${friendlyName}-config`,
  })),
  customerSheetQuickLink: (title, url) => ({ id: 1, name: title, url, icon: 'sheets' }),
  sheetHasConfigData: vi.fn(async () => true),
  syncCustomerToSheet: vi.fn(async () => {}),
  loadServersFromNetworkingTab: vi.fn(async () => []),
  loadDisplaySchedulesFromTab: vi.fn(async () => []),
  syncAllConfigTabsForCustomer: vi.fn(async () => ({ changedTabs: [] })),
}));

const openFromDrive = vi.hoisted(() => ({
  openConfigFromDriveFile: vi.fn(async () => ({
    customerId: 1, spreadsheetId: 'sheet-1', usedSetupJson: true,
    setupStatus: 'hydrated', setupError: null,
  })),
}));

vi.mock('../../services/GoogleDriveService', () => drive);
vi.mock('../../services/ConfigSheetSyncService', () => sync);
vi.mock('../../services/OpenConfigFromDriveService', () => openFromDrive);
vi.mock('../Weather', () => ({ default: () => <div data-testid="weather" /> }));
vi.mock('../CustomerSupportDialog', () => ({ default: () => null }));
vi.mock('../AppSettingsDialog', () => ({ default: () => null }));
vi.mock('../ReportIssueDialog', () => ({ default: () => null }));
vi.mock('../CustomerMapDialog', () => ({ default: () => null }));

const { useAppStore } = await import('../../stores/useAppStore');
const CustomerSelector = (await import('../CustomerSelector')).default;

const customerRec = (over = {}) => ({
  id: 1,
  customerId: 'acme',
  code: 'ACME',
  friendlyName: 'Acme',
  spreadsheetId: 'sheet-1',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
  spreadsheetTitle: 'Acme-config',
  config: {},
  garages: [],
  ...over,
});

function setStore({ customers = [] } = {}) {
  useAppStore.setState({
    customers,
    selectedCustomerId: null,
    selectedGarageId: null,
    selectedLevelId: null,
    currentView: 'customers',
    hydration: {},
    pendingRoute: null,
  });
}

const list = () => useAppStore.getState().customers;
const named = (name) => list().find((c) => c.friendlyName === name);

/** Labelled by a sibling <Label>; scoped to the dialog, tolerant of " *". */
function field(labelText) {
  const scope = screen.queryByRole('dialog') || document.body;
  for (const label of within(scope).getAllByText(labelText, { exact: false })) {
    const input = label.parentElement?.querySelector('input, textarea');
    if (input) return input;
  }
  throw new Error(`no input for label "${labelText}"`);
}

async function submit(user, name) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name }));
}
function submitButton(name) {
  return within(screen.getByRole('dialog')).getByRole('button', { name });
}
async function openAdd(user) {
  await user.click(screen.getAllByRole('button', { name: /add customer/i })[0]);
}

/**
 * Edit/Delete live inside the card's collapsed details panel, so the row has to
 * be expanded before either button exists.
 */
async function rowAction(user, label) {
  if (!screen.queryByRole('button', { name: label })) {
    // Several customers can be on screen, so expand the right card: walk up from
    // the name heading to the card, then use that card's own toggle.
    const name = label.replace(/^(Edit|Delete) customer /, '');
    let card = screen.getByRole('heading', { name });
    while (card && !card.className.includes('self-start')) card = card.parentElement;
    await user.click(within(card).getByRole('button', { name: /expand details/i }));
  }
  await user.click(await screen.findByRole('button', { name: label }));
}

beforeEach(() => {
  vi.clearAllMocks();
  drive.isSignedIn.mockReturnValue(true);
  drive.listAllConfigFilesInFolder.mockResolvedValue([]);
  setStore();
});
afterEach(cleanup);

// ── ADD ─────────────────────────────────────────────────────────────────────
describe('add a customer', () => {
  it('creates the config sheet and records its details', async () => {
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await openAdd(user);
    await user.type(field('Friendly Name'), 'Beta Health');
    await submit(user, /^add customer$/i);

    await waitFor(() => expect(list()).toHaveLength(1));
    const added = list()[0];
    expect(added.friendlyName).toBe('Beta Health');
    expect(added.spreadsheetId).toBe('sheet-new');
    expect(added.spreadsheetTitle).toBe('Beta Health-config');
    await waitFor(() => expect(sync.createCustomerConfigSheet).toHaveBeenCalled());
  });

  it('seeds a first site carrying the config sheet link', async () => {
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await openAdd(user);
    await user.type(field('Friendly Name'), 'Beta Health');
    await submit(user, /^add customer$/i);

    await waitFor(() => expect(list()).toHaveLength(1));
    const garage = list()[0].garages[0];
    expect(garage).toBeTruthy();
    expect(garage.levels).toHaveLength(1);
    expect(garage.quickLinks.some((l) => l.icon === 'sheets')).toBe(true);
  });

  it('stores the address on both the customer and its first site', async () => {
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await openAdd(user);
    await user.type(field('Friendly Name'), 'Beta Health');
    await user.type(field('Address'), '100 Main St');
    await user.type(field('City'), 'Boston');
    await submit(user, /^add customer$/i);

    await waitFor(() => expect(list()).toHaveLength(1));
    expect(list()[0].config.address).toBe('100 Main St');
    expect(list()[0].config.city).toBe('Boston');
    expect(list()[0].garages[0].address).toBe('100 Main St');
  });

  it('will not submit an empty name', async () => {
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await openAdd(user);

    expect(submitButton(/^add customer$/i).disabled).toBe(true);
    expect(sync.createCustomerConfigSheet).not.toHaveBeenCalled();
  });

  it('refuses a duplicate name before creating anything on Drive', async () => {
    const user = userEvent.setup();
    setStore({ customers: [customerRec({ friendlyName: 'Acme' })] });
    render(<CustomerSelector />);

    await openAdd(user);
    await user.type(field('Friendly Name'), 'acme');
    await submit(user, /^add customer$/i);

    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
    expect(list()).toHaveLength(1);
    // Nothing is created on Drive, so no orphan sheet is left behind.
    expect(sync.createCustomerConfigSheet).not.toHaveBeenCalled();
  });

  it('refuses to create anything while signed out', async () => {
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await openAdd(user);
    await user.type(field('Friendly Name'), 'Beta Health');
    drive.isSignedIn.mockReturnValue(false);
    await submit(user, /^add customer$/i);

    await waitFor(() => expect(screen.getByText(/sign in with google/i)).toBeTruthy());
    expect(sync.createCustomerConfigSheet).not.toHaveBeenCalled();
    expect(list()).toHaveLength(0);
  });

  it('adds nothing when the sheet cannot be created', async () => {
    const user = userEvent.setup();
    sync.createCustomerConfigSheet.mockRejectedValueOnce(new Error('Sheets API is not enabled'));
    render(<CustomerSelector />);

    await openAdd(user);
    await user.type(field('Friendly Name'), 'Beta Health');
    await submit(user, /^add customer$/i);

    await waitFor(() => expect(screen.getByText(/not enabled/i)).toBeTruthy());
    // A customer with no sheet could never be saved, so it is not added at all.
    expect(list()).toHaveLength(0);
  });
});

// ── EDIT / RENAME ───────────────────────────────────────────────────────────
describe('rename a customer', () => {
  it('renames the Drive file and syncs the Customer tab', async () => {
    const user = userEvent.setup();
    setStore({ customers: [customerRec()] });
    render(<CustomerSelector />);

    await rowAction(user, 'Edit customer Acme');
    const name = field('Friendly Name');
    await user.clear(name);
    await user.type(name, 'Acme Health');
    await submit(user, /^save$/i);

    await waitFor(() => expect(named('Acme Health')).toBeTruthy());
    expect(drive.renameDriveFile).toHaveBeenCalledWith('sheet-1', 'Acme Health-config');
    expect(named('Acme Health').spreadsheetTitle).toBe('Acme Health-config');
    await waitFor(() => expect(sync.syncCustomerToSheet).toHaveBeenCalled());
  });

  it('checks the new name is free on Drive first', async () => {
    const user = userEvent.setup();
    setStore({ customers: [customerRec()] });
    render(<CustomerSelector />);

    await rowAction(user, 'Edit customer Acme');
    const name = field('Friendly Name');
    await user.clear(name);
    await user.type(name, 'Acme Health');
    await submit(user, /^save$/i);

    await waitFor(() => expect(sync.assertConfigSheetNameAvailable).toHaveBeenCalled());
    // Its own files are excluded, so retrying a half-done rename is not blocked
    // by the file it already renamed.
    const call = sync.assertConfigSheetNameAvailable.mock.calls.at(-1);
    expect(call[1].excludeFileIds).toContain('sheet-1');
  });

  it('changes nothing locally when Drive rejects the rename', async () => {
    const user = userEvent.setup();
    setStore({ customers: [customerRec()] });
    drive.renameDriveFile.mockRejectedValueOnce(new Error('Drive rename failed'));
    render(<CustomerSelector />);

    await rowAction(user, 'Edit customer Acme');
    const name = field('Friendly Name');
    await user.clear(name);
    await user.type(name, 'Acme Health');
    await submit(user, /^save$/i);

    await waitFor(() => expect(screen.getByText(/rename failed/i)).toBeTruthy());
    // Claiming a rename Drive refused would leave the catalog disagreeing.
    expect(named('Acme Health')).toBeUndefined();
    expect(named('Acme')).toBeTruthy();
  });

  it('rolls the Sheet name back when the companion xlsx cannot be renamed', async () => {
    const user = userEvent.setup();
    setStore({
      customers: [customerRec({ sourceFileId: 'xlsx-1', sourceFileName: 'Acme-config.xlsx' })],
    });
    // The Sheet renames, the xlsx does not.
    drive.renameDriveFile
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('xlsx rename failed'));
    render(<CustomerSelector />);

    await rowAction(user, 'Edit customer Acme');
    const name = field('Friendly Name');
    await user.clear(name);
    await user.type(name, 'Acme Health');
    await submit(user, /^save$/i);

    await waitFor(() => expect(screen.getByText(/xlsx rename failed/i)).toBeTruthy());
    // The Sheet is put back, so the two file-name stems stay matched and the
    // catalog keeps showing one row rather than two.
    expect(drive.renameDriveFile).toHaveBeenCalledWith('sheet-1', 'Acme-config');
    expect(named('Acme Health')).toBeUndefined();
  });

  it('keeps the rename when only the Customer tab sync fails', async () => {
    const user = userEvent.setup();
    setStore({ customers: [customerRec()] });
    sync.syncCustomerToSheet.mockRejectedValueOnce(new Error('Sheets rate limit reached'));
    render(<CustomerSelector />);

    await rowAction(user, 'Edit customer Acme');
    const name = field('Friendly Name');
    await user.clear(name);
    await user.type(name, 'Acme Health');
    await submit(user, /^save$/i);

    await waitFor(() => expect(screen.getByText(/rate limit/i)).toBeTruthy());
    // The file really was renamed on Drive, so local state has to match it or
    // a retry would try to rename an already-renamed file.
    expect(named('Acme Health')).toBeTruthy();
    expect(named('Acme Health').spreadsheetTitle).toBe('Acme Health-config');
  });

  it('refuses a name another customer already uses', async () => {
    const user = userEvent.setup();
    setStore({
      customers: [customerRec({ id: 1, friendlyName: 'Acme' }), customerRec({ id: 2, customerId: 'beta', friendlyName: 'Beta' })],
    });
    render(<CustomerSelector />);

    await rowAction(user, 'Edit customer Acme');
    const name = field('Friendly Name');
    await user.clear(name);
    await user.type(name, 'Beta');
    await submit(user, /^save$/i);

    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
    expect(drive.renameDriveFile).not.toHaveBeenCalled();
  });

  it('an address-only edit syncs without renaming anything', async () => {
    const user = userEvent.setup();
    setStore({ customers: [customerRec()] });
    render(<CustomerSelector />);

    await rowAction(user, 'Edit customer Acme');
    await user.type(field('Address'), '200 Side St');
    await submit(user, /^save$/i);

    await waitFor(() => expect(named('Acme').config.address).toBe('200 Side St'));
    expect(drive.renameDriveFile).not.toHaveBeenCalled();
    await waitFor(() => expect(sync.syncCustomerToSheet).toHaveBeenCalled());
  });
});

// ── DELETE ──────────────────────────────────────────────────────────────────
describe('remove a customer', () => {
  it('asks first and removes only from the app, never from Drive', async () => {
    const user = userEvent.setup();
    setStore({ customers: [customerRec()] });
    render(<CustomerSelector />);

    await rowAction(user, 'Delete customer Acme');

    // The wording matters: the sheet survives, so this is not destructive.
    await waitFor(() => expect(screen.getByText(/remove "Acme" from this app/i)).toBeTruthy());
    expect(list()).toHaveLength(1);

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^(delete|remove)$/i }));

    await waitFor(() => expect(list()).toHaveLength(0));
  });

  it('leaves the customer alone when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    setStore({ customers: [customerRec()] });
    render(<CustomerSelector />);

    await rowAction(user, 'Delete customer Acme');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(list()).toHaveLength(1);
  });
});
