// @vitest-environment jsdom
/**
 * QA — SiteSelector: the sites screen.
 *
 * Small screen, outsized consequences. A rename has to retarget every device row
 * that references the old site name, and a delete has to clear rows across ten
 * tabs while sparing a display group another site still uses. Both look correct
 * in the app and are only wrong on the sheet, so the assertions here check what
 * was asked of the sync layer, not just what the list shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const sync = vi.hoisted(() => ({
  syncSiteToSheet: vi.fn(async () => {}),
  deleteSiteFromSheet: vi.fn(async () => {}),
  loadServersFromNetworkingTab: vi.fn(async () => []),
  loadDisplaySchedulesFromTab: vi.fn(async () => []),
  syncAllConfigTabsForCustomer: vi.fn(async () => ({ changedTabs: [] })),
}));

vi.mock('../Weather', () => ({ default: () => <div data-testid="weather" /> }));
vi.mock('../SetupSyncIndicator', () => ({ default: () => <div data-testid="setup-sync" /> }));

const { useAppStore } = await import('../../stores/useAppStore');
const SiteSelector = (await import('../SiteSelector')).default;

const CUSTOMER_ID = 1;

const site = (over = {}) => ({
  id: 1, name: 'North', internalName: 'North',
  address: '', city: '', state: '', zip: '', mapsUrl: '',
  levels: [], quickLinks: [], contacts: [], servers: [],
  displayGroups: [], sensorGroups: [], mdfIdfLocations: [],
  ...over,
});

function setStore({ sites = [], canSync = true, customer = {}, selectedSiteId = null } = {}) {
  useAppStore.setState({
    customers: [{
      id: CUSTOMER_ID, customerId: 'acme', code: 'ACME', friendlyName: 'Acme',
      ...(canSync ? { spreadsheetId: 'sheet-1' } : {}),
      sites, config: {}, ...customer,
    }],
    selectedCustomerId: CUSTOMER_ID,
    selectedSiteId,
    selectedLevelId: null,
    currentView: 'sites',
    hydration: { [CUSTOMER_ID]: 'hydrated' },
    pendingRoute: null,
  });
}

const sites = () => useAppStore.getState().customers[0].sites;
const siteNamed = (name) => sites().find((s) => s.name === name);

/**
 * Inputs are labelled by a sibling <Label>, not by htmlFor. Scoped to the open
 * dialog — label text like "Address" also appears on the site cards behind it.
 */
function field(labelText) {
  // Scoped to the dialog: "Address" also appears on the site cards behind it.
  // Substring match: required labels carry a " *" suffix.
  const scope = screen.queryByRole('dialog') || document.body;
  const matches = within(scope).getAllByText(labelText, { exact: false });
  for (const label of matches) {
    const input = label.parentElement?.querySelector('input, textarea');
    if (input) return input;
  }
  throw new Error(`no input for label "${labelText}"`);
}

/**
 * The dialog submit shares its text with the trigger behind it ("Add Site"), so
 * it is always resolved inside the dialog.
 */
async function submit(user, name) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name }));
}
function submitButton(name) {
  return within(screen.getByRole('dialog')).getByRole('button', { name });
}
async function confirmDelete(user) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
}
async function openAddSite(user) {
  await user.click(screen.getAllByRole('button', { name: /add site/i })[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  setStore();
});
afterEach(cleanup);

// ── ADD ─────────────────────────────────────────────────────────────────────
describe('add a site', () => {
  it('creates it, seeds a first level, and syncs', async () => {
    const user = userEvent.setup();
    render(<SiteSelector />);

    await openAddSite(user);
    await user.type(field('Site Name'), 'North Deck');
    await submit(user, /^add site$/i);

    await waitFor(() => expect(sites()).toHaveLength(1));
    const added = sites()[0];
    expect(added.name).toBe('North Deck');
    expect(added.internalName).toBe('North Deck');
    // A site with no levels cannot hold devices, so one is seeded.
    expect(added.levels).toHaveLength(1);
    expect(added.levels[0].name).toBe('Level 1');
    expect(added.levels[0].totalSpots).toBe(0);
    await waitFor(() => expect(sync.syncSiteToSheet).toHaveBeenCalled());
  });

  it('will not submit an empty name', async () => {
    const user = userEvent.setup();
    render(<SiteSelector />);

    await openAddSite(user);

    expect(submitButton(/^add site$/i).disabled).toBe(true);
    expect(sites()).toHaveLength(0);
    expect(sync.syncSiteToSheet).not.toHaveBeenCalled();
  });

  it('refuses a duplicate name regardless of case, without syncing', async () => {
    const user = userEvent.setup();
    setStore({ sites: [site({ name: 'North' })] });
    render(<SiteSelector />);

    await openAddSite(user);
    await user.type(field('Site Name'), 'nOrTh');
    await submit(user, /^add site$/i);

    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
    expect(sites()).toHaveLength(1);
    expect(sync.syncSiteToSheet).not.toHaveBeenCalled();
  });

  it('stores address fields the user typed', async () => {
    const user = userEvent.setup();
    render(<SiteSelector />);

    await openAddSite(user);
    await user.type(field('Site Name'), 'North Deck');
    await user.type(field('Address'), '100 Main St');
    await user.type(field('City'), 'Boston');
    await user.type(field('State'), 'MA');
    await user.type(field('ZIP'), '02101');
    await submit(user, /^add site$/i);

    await waitFor(() => expect(sites()).toHaveLength(1));
    const added = sites()[0];
    expect(added.address).toBe('100 Main St');
    expect(added.city).toBe('Boston');
    expect(added.state).toBe('MA');
    expect(added.zip).toBe('02101');
  });

  it('attaches the config sheet link when the customer has one', async () => {
    const user = userEvent.setup();
    setStore({
      customer: {
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/s/edit',
        spreadsheetTitle: 'Acme-config',
      },
    });
    render(<SiteSelector />);

    await openAddSite(user);
    await user.type(field('Site Name'), 'North Deck');
    await submit(user, /^add site$/i);

    await waitFor(() => expect(sites()).toHaveLength(1));
    const link = sites()[0].quickLinks.find((l) => l.icon === 'sheets');
    expect(link).toBeTruthy();
    expect(link.url).toContain('docs.google.com');
  });
});

// ── ADD FAILURE ─────────────────────────────────────────────────────────────
describe('when the sync fails while adding', () => {
  it('rolls the new site back so a retry cannot duplicate it', async () => {
    const user = userEvent.setup();
    sync.syncSiteToSheet.mockRejectedValueOnce(new Error('Sheets rate limit reached'));
    render(<SiteSelector />);

    await openAddSite(user);
    await user.type(field('Site Name'), 'North Deck');
    await submit(user, /^add site$/i);

    await waitFor(() => expect(screen.getByText(/rate limit/i)).toBeTruthy());
    // Optimistically added, then undone — otherwise pressing Add again would
    // leave two sites with the same name.
    expect(sites()).toHaveLength(0);
  });

  it('leaves a site added elsewhere untouched while rolling back', async () => {
    const user = userEvent.setup();
    sync.syncSiteToSheet.mockImplementationOnce(async () => {
      // A concurrent change lands mid-sync, exactly as a hydrate would.
      useAppStore.getState().setSites((prev) => [...prev, site({ id: 99, name: 'Elsewhere' })]);
      throw new Error('Sheets rate limit reached');
    });
    render(<SiteSelector />);

    await openAddSite(user);
    await user.type(field('Site Name'), 'North Deck');
    await submit(user, /^add site$/i);

    await waitFor(() => expect(screen.getByText(/rate limit/i)).toBeTruthy());
    // The rollback removes only the failed add, not whatever else arrived.
    expect(sites().map((s) => s.name)).toEqual(['Elsewhere']);
  });
});

// ── EDIT ────────────────────────────────────────────────────────────────────
describe('edit a site', () => {
  it('renames it and hands the sync the previous name', async () => {
    const user = userEvent.setup();
    setStore({ sites: [site({ name: 'North', internalName: 'North' })] });
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: 'Edit North' }));
    const nameInput = field('Site Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'North Deck');
    await submit(user, /save changes/i);

    await waitFor(() => expect(siteNamed('North Deck')).toBeTruthy());
    await waitFor(() => expect(sync.syncSiteToSheet).toHaveBeenCalled());

    // Without previousSite a rename orphans every device row keyed to the old
    // site name — the rows are found by name, not by id.
    const call = sync.syncSiteToSheet.mock.calls.at(-1)[0];
    expect(call.previousSite).toEqual({ internalName: 'North', name: 'North' });
    expect(call.site.internalName).toBe('North Deck');
  });

  it('keeps the local change when the sync fails — the opposite of an add', async () => {
    const user = userEvent.setup();
    setStore({ sites: [site({ name: 'North' })] });
    sync.syncSiteToSheet.mockRejectedValueOnce(new Error('Sheets rate limit reached'));
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: 'Edit North' }));
    const nameInput = field('Site Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'North Deck');
    await submit(user, /save changes/i);

    await waitFor(() => expect(screen.getByText(/rate limit/i)).toBeTruthy());
    // An edit is not rolled back: the rename is already in the app and undoing
    // it would lose the user's typing.
    expect(siteNamed('North Deck')).toBeTruthy();
  });

  it('leaves an inherited address unset so the site keeps following the customer', async () => {
    const user = userEvent.setup();
    setStore({
      sites: [site({ name: 'North' })],
      customer: { config: { address: '100 Main St', city: 'Boston', state: 'MA', zip: '02101', mapsUrl: '' } },
    });
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: 'Edit North' }));
    // The form is prefilled from the customer; save without touching it.
    expect(field('Address').value).toBe('100 Main St');
    await submit(user, /save changes/i);

    await waitFor(() => expect(sync.syncSiteToSheet).toHaveBeenCalled());
    // Stored empty, so changing the customer address still moves this site.
    expect(siteNamed('North').address).toBe('');
    expect(siteNamed('North').city).toBe('');
  });

  it('stores an address the user actually edited', async () => {
    const user = userEvent.setup();
    setStore({
      sites: [site({ name: 'North' })],
      customer: { config: { address: '100 Main St', city: 'Boston', state: 'MA', zip: '02101', mapsUrl: '' } },
    });
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: 'Edit North' }));
    const address = field('Address');
    await user.clear(address);
    await user.type(address, '200 Side St');
    await submit(user, /save changes/i);

    await waitFor(() => expect(siteNamed('North').address).toBe('200 Side St'));
  });
});

// ── DELETE ──────────────────────────────────────────────────────────────────
describe('delete a site', () => {
  it('does nothing until the confirmation is accepted', async () => {
    const user = userEvent.setup();
    setStore({ sites: [site({ name: 'North' })] });
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: 'Delete North' }));

    await waitFor(() => expect(screen.getByText('Confirm Delete')).toBeTruthy());
    expect(sites()).toHaveLength(1);
    expect(sync.deleteSiteFromSheet).not.toHaveBeenCalled();
  });

  it('removes it and passes the remaining sites to the sync', async () => {
    const user = userEvent.setup();
    setStore({ sites: [site({ id: 1, name: 'North' }), site({ id: 2, name: 'South' })] });
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: 'Delete North' }));
    await confirmDelete(user);

    await waitFor(() => expect(sites()).toHaveLength(1));
    expect(sites()[0].name).toBe('South');

    // otherSites is what spares a display group South still uses.
    const call = sync.deleteSiteFromSheet.mock.calls.at(-1)[0];
    expect(call.site.name).toBe('North');
    expect(call.otherSites.map((s) => s.name)).toEqual(['South']);
  });

  it('clears the selection when the deleted site was the selected one', async () => {
    const user = userEvent.setup();
    setStore({ sites: [site({ id: 1, name: 'North' })], selectedSiteId: 1 });
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: 'Delete North' }));
    await confirmDelete(user);

    await waitFor(() => expect(useAppStore.getState().selectedSiteId).toBeNull());
  });

  it('says so when the sheet delete fails', async () => {
    const user = userEvent.setup();
    setStore({ sites: [site({ name: 'North' })] });
    sync.deleteSiteFromSheet.mockRejectedValueOnce(new Error('Sheets rate limit reached'));
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: 'Delete North' }));
    await confirmDelete(user);

    await waitFor(() => expect(screen.getByText(/rate limit/i)).toBeTruthy());
  });
});

// ── QUICK LINKS ─────────────────────────────────────────────────────────────
describe('quick links', () => {
  it('will not submit a malformed URL', async () => {
    const user = userEvent.setup();
    setStore({ sites: [site({ name: 'North' })] });
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: /add link/i }));
    await user.type(field('Name'), 'Docs');
    await user.type(field('URL'), 'not a url');

    expect(submitButton(/^save$/i).disabled).toBe(true);
  });

  it('stores a valid link on the right site, with no sheet write', async () => {
    const user = userEvent.setup();
    setStore({ sites: [site({ name: 'North' })] });
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: /add link/i }));
    await user.type(field('Name'), 'Docs');
    await user.type(field('URL'), 'https://example.test/docs');
    await submit(user, /^save$/i);

    await waitFor(() => expect(siteNamed('North').quickLinks).toHaveLength(1));
    expect(siteNamed('North').quickLinks[0].name).toBe('Docs');
    // Quick links are app-only; no config tab holds them.
    expect(sync.syncSiteToSheet).not.toHaveBeenCalled();
  });

  it('deletes only the chosen link, after confirming', async () => {
    const user = userEvent.setup();
    setStore({
      sites: [site({
        name: 'North',
        quickLinks: [
          { id: 1, name: 'Docs', url: 'https://example.test/a', icon: 'link' },
          { id: 2, name: 'Wiki', url: 'https://example.test/b', icon: 'link' },
        ],
      })],
    });
    render(<SiteSelector />);

    await user.click(screen.getByRole('button', { name: 'Delete link Docs' }));
    await confirmDelete(user);

    await waitFor(() => expect(siteNamed('North').quickLinks).toHaveLength(1));
    expect(siteNamed('North').quickLinks[0].name).toBe('Wiki');
    expect(sync.syncSiteToSheet).not.toHaveBeenCalled();
  });
});

// ── NO WRITABLE SHEET ───────────────────────────────────────────────────────
describe('a customer with no writable sheet', () => {
  it('adds the site locally and never calls the sync', async () => {
    const user = userEvent.setup();
    setStore({ canSync: false });
    render(<SiteSelector />);

    await openAddSite(user);
    await user.type(field('Site Name'), 'North Deck');
    await submit(user, /^add site$/i);

    await waitFor(() => expect(sites()).toHaveLength(1));
    expect(sync.syncSiteToSheet).not.toHaveBeenCalled();
  });
});
