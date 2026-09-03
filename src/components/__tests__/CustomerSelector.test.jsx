// @vitest-environment jsdom
/**
 * QA — CustomerSelector: the customer list is the shared database plus the
 * site-config spreadsheets in the shared Drive folder, and the only screen
 * that creates, imports, renames and removes customers.
 *
 * Reading Drive is a separate consent from the primary app sign-in: each
 * browser needs its own Drive OAuth token (GoogleDriveService.isSignedIn) —
 * everyone already has an @ensight-technologies.com Google account, so this
 * is one more consent screen for that account, not a service account or a
 * second login. What must hold: a Drive file that is not in the database yet
 * is shown and imports on click through ImportCustomerFromDriveService
 * (which is what writes the rows); an already imported customer is never
 * silently replaced — "Reload from Drive" asks first; create/rename/delete
 * go through CustomerRepository and the store only reflects what the server
 * accepted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const drive = vi.hoisted(() => ({
  signInWithGoogle: vi.fn(async () => {}),
  signOut: vi.fn(),
  isSignedIn: vi.fn(() => true),
  verifySharedFolderAccess: vi.fn(async () => true),
  listAllConfigFilesInFolder: vi.fn(async () => ({ files: [] })),
}));
const importer = vi.hoisted(() => ({
  importCustomerFromDrive: vi.fn(),
}));
const repo = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  updateCustomerInfo: vi.fn(async () => ({ updatedAt: '2026-09-02T12:00:00.000Z' })),
  deleteCustomer: vi.fn(async () => {}),
  loadCustomerFull: vi.fn(async () => null),
  loadCustomerCard: vi.fn(async () => null),
  listCustomers: vi.fn(async () => []),
  subscribeToCustomersTable: vi.fn(() => () => {}),
  subscribeToCustomerChanges: vi.fn(() => () => {}),
}));
const auth = vi.hoisted(() => ({
  renderSignInButton: vi.fn(async () => {}),
  onSignInError: vi.fn(() => () => {}),
  signOut: vi.fn(async () => {}),
}));

vi.mock('../../services/GoogleDriveService', () => drive);
vi.mock('../../services/ImportCustomerFromDriveService', () => importer);
vi.mock('../../services/CustomerRepository', () => repo);
vi.mock('../../services/GoogleAuthService', () => auth);
vi.mock('../Weather', () => ({ default: () => <div data-testid="weather" /> }));
vi.mock('../CustomerSupportDialog', () => ({ default: () => null }));
vi.mock('../AppSettingsDialog', () => ({ default: () => null }));
vi.mock('../ReportIssueDialog', () => ({ default: () => null }));
vi.mock('../CustomerMapDialog', () => ({ default: () => null }));

const { useAppStore } = await import('../../stores/useAppStore');
const CustomerSelector = (await import('../CustomerSelector')).default;

const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const driveFile = (over = {}) => ({
  id: 'drive-acme', name: 'Acme-config', mimeType: SHEET_MIME,
  webViewLink: 'https://docs.google.com/spreadsheets/d/drive-acme/edit', ...over,
});

const customerRec = (over = {}) => ({
  id: 'row-acme',
  customerId: 'acme',
  code: 'ACME',
  friendlyName: 'Acme',
  spreadsheetId: null,
  config: {},
  sites: [],
  ...over,
});

function setStore({ customers = [], session = { email: 'tech@ensight-technologies.com' } } = {}) {
  useAppStore.setState({
    customers,
    session,
    selectedCustomerId: null,
    selectedSiteId: null,
    selectedLevelId: null,
    currentView: 'customers',
    hydration: {},
    pendingRoute: null,
  });
}

const list = () => useAppStore.getState().customers;

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
async function openAdd(user) {
  await user.click(screen.getAllByRole('button', { name: /add customer/i })[0]);
}

/** Expand a customer card (Edit/Delete/Reload live in the collapsed panel). */
async function expandCard(user, name) {
  let card = screen.getByRole('heading', { name });
  while (card && !card.className.includes('self-start')) card = card.parentElement;
  await user.click(within(card).getByRole('button', { name: /expand details/i }));
  return card;
}

beforeEach(() => {
  vi.clearAllMocks();
  drive.isSignedIn.mockReturnValue(true);
  drive.verifySharedFolderAccess.mockResolvedValue(true);
  drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [] });
  importer.importCustomerFromDrive.mockResolvedValue({
    customerId: 'row-acme', mode: 'created', friendlyName: 'Acme Parking',
    summary: { sites: 1, levels: 2, zones: 1, devices: 6, servers: 2 }, warnings: [],
  });
  repo.createCustomer.mockImplementation(async (payload) => ({
    customer: { ...payload, id: 'row-new' },
    updatedAt: '2026-09-02T12:00:00.000Z',
  }));
  setStore();
});
afterEach(cleanup);

// ── DRIVE CATALOG ───────────────────────────────────────────────────────────
describe('Drive site-configs', () => {
  it('loads the shared folder as soon as there is a session and a Drive token, and lists files not yet imported', async () => {
    drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [driveFile()] });
    render(<CustomerSelector />);

    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeTruthy();
    expect(screen.getByText(/available in drive/i)).toBeTruthy();
    expect(screen.getByText(/not imported yet/i)).toBeTruthy();
    expect(drive.listAllConfigFilesInFolder).toHaveBeenCalledTimes(1);
  });

  it('does not touch Drive while signed out of the app', async () => {
    setStore({ session: null });
    render(<CustomerSelector />);
    await waitFor(() => expect(auth.renderSignInButton).toHaveBeenCalled());
    expect(drive.listAllConfigFilesInFolder).not.toHaveBeenCalled();
  });

  it('does not auto-fetch or error until this browser has granted Drive access', async () => {
    drive.isSignedIn.mockReturnValue(false);
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await waitFor(() => expect(screen.getByRole('button', { name: /sync/i })).toBeTruthy());
    expect(drive.listAllConfigFilesInFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('button', { name: /sync/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/sign in with google to load site configs/i);
    expect(drive.listAllConfigFilesInFolder).not.toHaveBeenCalled();
  });

  it('shows a plain Retry for a transient failure once Drive access already exists', async () => {
    drive.listAllConfigFilesInFolder.mockRejectedValueOnce(new Error('Google request timed out. Please try again.'));
    drive.listAllConfigFilesInFolder.mockResolvedValueOnce({ files: [driveFile()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/timed out/i);
    expect(within(alert).queryByRole('button', { name: /grant drive access/i })).toBeNull();
    await user.click(within(alert).getByRole('button', { name: /retry/i }));
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeTruthy();
  });

  it('shows Grant Drive Access when the folder itself refuses this account, and recovers after granting', async () => {
    const forbidden = Object.assign(new Error('Google Drive access was denied (403).'), { code: 'DRIVE_FORBIDDEN' });
    drive.listAllConfigFilesInFolder.mockRejectedValueOnce(forbidden);
    drive.listAllConfigFilesInFolder.mockResolvedValueOnce({ files: [driveFile()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull();
    const grantButton = screen.getByRole('button', { name: /grant drive access/i });

    await user.click(grantButton);
    expect(drive.signInWithGoogle).toHaveBeenCalledWith({ prompt: 'consent' });
    expect(drive.verifySharedFolderAccess).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /grant drive access/i })).toBeNull();
  });

  it('keeps showing Grant Drive Access when the folder is still not shared with this account after granting', async () => {
    const forbidden = Object.assign(new Error('denied'), { code: 'DRIVE_FORBIDDEN' });
    drive.listAllConfigFilesInFolder.mockRejectedValue(forbidden);
    drive.verifySharedFolderAccess.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /grant drive access/i }));

    expect(await screen.findByText(/access to the configuration folder was denied/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /grant drive access/i })).toBeTruthy();
  });

  it('re-checks Drive access before importing a not-yet-imported row', async () => {
    // The catalog fetch itself needed a Drive token; check that a token lost since then
    // (expiry, revoked access) is caught again at click time, not assumed from the fetch.
    drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [driveFile()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await screen.findByRole('heading', { name: 'Acme' });
    drive.isSignedIn.mockReturnValue(false);
    await user.click(screen.getByRole('heading', { name: 'Acme' }));

    // handleRowActivate's isSignedIn() guard sets authError, which (like the rest of the
    // pre-existing auth-error banner) only renders while signed out of the app entirely —
    // the guard's real, testable effect is that nothing gets imported.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(importer.importCustomerFromDrive).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('re-checks Drive access before reloading an already-imported customer', async () => {
    const existing = customerRec({ spreadsheetId: 'drive-acme' });
    setStore({ customers: [existing] });
    drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [driveFile()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await waitFor(() => expect(drive.listAllConfigFilesInFolder).toHaveBeenCalled());
    await expandCard(user, 'Acme');
    drive.isSignedIn.mockReturnValue(false);
    await user.click(await screen.findByRole('button', { name: /reload from drive/i }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(importer.importCustomerFromDrive).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('imports a Drive-only row on click, shows the summary, and opens it from the dialog', async () => {
    drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [driveFile()] });
    importer.importCustomerFromDrive.mockImplementation(async ({ store }) => {
      store.addCustomer(customerRec({ friendlyName: 'Acme Parking' }));
      return {
        customerId: 'row-acme', mode: 'created', friendlyName: 'Acme Parking',
        summary: { sites: 1, levels: 2, zones: 1, devices: 6, servers: 2 },
        warnings: ['1 DisplayLevels row(s) were skipped: no matching DisplayControllers row or level.'],
      };
    });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await user.click(await screen.findByRole('heading', { name: 'Acme' }));

    await waitFor(() => expect(importer.importCustomerFromDrive).toHaveBeenCalledTimes(1));
    const args = importer.importCustomerFromDrive.mock.calls[0][0];
    expect(args.file).toMatchObject({ id: 'drive-acme', name: 'Acme-config' });
    expect(args.existingCustomer).toBeNull();
    expect(args.select).toBe(false);
    expect(typeof args.store.addCustomer).toBe('function');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/imported from drive/i)).toBeTruthy();
    expect(within(dialog).getByText(/1 sites · 2 levels · 1 zones · 6 devices · 2 servers/)).toBeTruthy();
    expect(within(dialog).getByText(/DisplayLevels row\(s\) were skipped/)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: /open/i }));
    await waitFor(() => expect(useAppStore.getState().selectedCustomerId).toBe('row-acme'));
    expect(useAppStore.getState().currentView).toBe('sites');
  });

  it('reports an import failure inside the dialog and saves nothing locally', async () => {
    drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [driveFile()] });
    importer.importCustomerFromDrive.mockRejectedValueOnce(new Error('Customer row insert failed'));
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await user.click(await screen.findByRole('heading', { name: 'Acme' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Customer row insert failed/)).toBeTruthy();
    expect(list()).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('asks before reloading an imported customer, offering merge and full reload', async () => {
    const existing = customerRec({ spreadsheetId: 'drive-acme' });
    setStore({ customers: [existing] });
    drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [driveFile()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await waitFor(() => expect(drive.listAllConfigFilesInFolder).toHaveBeenCalled());
    await expandCard(user, 'Acme');
    await user.click(await screen.findByRole('button', { name: /reload from drive/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/recommended/i)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /^merge with sheet$/i })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /^reload from drive$/i })).toBeTruthy();
    expect(importer.importCustomerFromDrive).not.toHaveBeenCalled();
  });

  it('defaults to merging with the sheet, keeping app-only data', async () => {
    const existing = customerRec({ spreadsheetId: 'drive-acme' });
    setStore({ customers: [existing] });
    drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [driveFile()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await waitFor(() => expect(drive.listAllConfigFilesInFolder).toHaveBeenCalled());
    await expandCard(user, 'Acme');
    await user.click(await screen.findByRole('button', { name: /reload from drive/i }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: /^merge with sheet$/i }));
    await waitFor(() => expect(importer.importCustomerFromDrive).toHaveBeenCalledTimes(1));
    const args = importer.importCustomerFromDrive.mock.calls[0][0];
    expect(args.existingCustomer).toMatchObject({ id: 'row-acme' });
    expect(args.mode).toBe('merge');
  });

  it('replaces the customer outright when Reload from Drive is chosen instead', async () => {
    const existing = customerRec({ spreadsheetId: 'drive-acme' });
    setStore({ customers: [existing] });
    drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [driveFile()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await waitFor(() => expect(drive.listAllConfigFilesInFolder).toHaveBeenCalled());
    await expandCard(user, 'Acme');
    await user.click(await screen.findByRole('button', { name: /reload from drive/i }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: /^reload from drive$/i }));
    await waitFor(() => expect(importer.importCustomerFromDrive).toHaveBeenCalledTimes(1));
    const args = importer.importCustomerFromDrive.mock.calls[0][0];
    expect(args.existingCustomer).toMatchObject({ id: 'row-acme' });
    expect(args.mode).toBe('replace');
  });

  it('opens an imported customer directly without going back to Drive', async () => {
    setStore({ customers: [customerRec({ spreadsheetId: 'drive-acme' })] });
    drive.listAllConfigFilesInFolder.mockResolvedValue({ files: [driveFile()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await user.click(await screen.findByRole('heading', { name: 'Acme' }));
    await waitFor(() => expect(useAppStore.getState().selectedCustomerId).toBe('row-acme'));
    expect(importer.importCustomerFromDrive).not.toHaveBeenCalled();
    expect(screen.queryByText(/available in drive/i)).toBeNull();
  });
});

// ── ADD ─────────────────────────────────────────────────────────────────────
describe('add a customer', () => {
  it('creates the row through the repository and adds what the server returned', async () => {
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await openAdd(user);
    await user.type(field('Friendly Name'), 'Beta Health');
    await user.type(field('City'), 'Boston');
    await submit(user, /^add customer$/i);

    await waitFor(() => expect(list()).toHaveLength(1));
    expect(repo.createCustomer).toHaveBeenCalledTimes(1);
    expect(repo.createCustomer.mock.calls[0][0]).toMatchObject({ customerId: 'beta-health', friendlyName: 'Beta Health' });
    expect(list()[0].id).toBe('row-new');
    expect(list()[0].config.city).toBe('Boston');
    expect(list()[0].sites[0].levels).toHaveLength(1);
  });

  it('refuses a duplicate name before calling the server', async () => {
    const user = userEvent.setup();
    setStore({ customers: [customerRec({ friendlyName: 'Acme' })] });
    render(<CustomerSelector />);

    await openAdd(user);
    await user.type(field('Friendly Name'), 'acme');
    await submit(user, /^add customer$/i);

    expect(await screen.findByText(/already exists/i)).toBeTruthy();
    expect(repo.createCustomer).not.toHaveBeenCalled();
  });

  it('adds nothing when the server rejects the create', async () => {
    repo.createCustomer.mockRejectedValueOnce(new Error('Database is not configured'));
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await openAdd(user);
    await user.type(field('Friendly Name'), 'Beta Health');
    await submit(user, /^add customer$/i);

    expect(await screen.findByText(/Database is not configured/)).toBeTruthy();
    expect(list()).toHaveLength(0);
  });
});

// ── EDIT / DELETE ───────────────────────────────────────────────────────────
describe('edit and remove a customer', () => {
  it('renames through the repository and keeps the server timestamp', async () => {
    setStore({ customers: [customerRec()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await expandCard(user, 'Acme');
    await user.click(await screen.findByRole('button', { name: /edit customer acme/i }));
    const input = field('Friendly Name');
    await user.clear(input);
    await user.type(input, 'Acme Parking');
    await submit(user, /^save$/i);

    await waitFor(() => expect(repo.updateCustomerInfo).toHaveBeenCalledWith('row-acme', expect.objectContaining({ friendlyName: 'Acme Parking' })));
    expect(list()[0].friendlyName).toBe('Acme Parking');
    expect(list()[0].lastSetupSavedAt).toBe('2026-09-02T12:00:00.000Z');
  });

  it('asks first, then deletes on the server and locally', async () => {
    setStore({ customers: [customerRec()] });
    const user = userEvent.setup();
    render(<CustomerSelector />);

    await expandCard(user, 'Acme');
    await user.click(await screen.findByRole('button', { name: /delete customer acme/i }));
    expect(repo.deleteCustomer).not.toHaveBeenCalled();
    await submit(user, /^delete$/i);

    await waitFor(() => expect(repo.deleteCustomer).toHaveBeenCalledWith('row-acme'));
    expect(list()).toHaveLength(0);
  });
});
