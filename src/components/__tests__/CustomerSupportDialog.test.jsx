// @vitest-environment jsdom
/**
 * QA — CustomerSupportDialog: the last form that writes to the Customer tab.
 *
 * Small, but it is the only editor for four fields that the downstream system
 * reads off the sheet, and it patches `config` rather than replacing it — so
 * the failure mode is not a wrong support value, it is a support edit quietly
 * wiping the customer's address on its way past.
 *
 * The other thing worth pinning is what happens when the sheet write fails:
 * the local change is already committed by then, so the dialog has to stay open
 * and say so rather than closing as though it had saved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const sync = vi.hoisted(() => ({ syncCustomerToSheet: vi.fn(async () => {}) }));

const { useAppStore } = await import('../../stores/useAppStore');
const CustomerSupportDialog = (await import('../CustomerSupportDialog')).default;

const customer = (over = {}) => ({
  id: 1,
  customerId: 'acme',
  friendlyName: 'Acme',
  spreadsheetId: 'sheet-1',
  config: {
    address: '100 Main St',
    city: 'Boston',
    state: 'MA',
    zip: '02110',
    support: {
      maintenanceProvider: '',
      maintenanceOther: '',
      enterpriseSite: false,
      support24Hour: false,
    },
  },
  sites: [],
  ...over,
});

let onOpenChange;

function mount(cust = customer()) {
  useAppStore.setState({
    customers: [cust],
    selectedCustomerId: 1,
    hydration: { 1: 'hydrated' },
    pendingRoute: null,
  });
  return render(
    <CustomerSupportDialog customer={cust} open onOpenChange={onOpenChange} />,
  );
}

const stored = () => useAppStore.getState().customers[0];
const support = () => stored().config.support;
/** The customer handed to the sheet writer — what actually gets written. */
const synced = () => sync.syncCustomerToSheet.mock.calls[0][0].customer;

const dialogButton = (name) =>
  within(screen.getByRole('dialog')).getByRole('button', { name });

async function chooseProvider(user, label) {
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: label }));
}

const save = (user) => user.click(dialogButton(/^save$/i));

beforeEach(() => {
  vi.clearAllMocks();
  onOpenChange = vi.fn();
  sync.syncCustomerToSheet.mockResolvedValue(undefined);
});
afterEach(cleanup);

// ── WHAT IT SHOWS ───────────────────────────────────────────────────────────
describe('opening the dialog', () => {
  it('renders nothing without a customer', () => {
    const { container } = render(
      <CustomerSupportDialog customer={null} open onOpenChange={onOpenChange} />,
    );
    expect(container.textContent).toBe('');
  });

  it('names the customer it is editing', () => {
    mount();
    expect(screen.getByText('Acme')).toBeTruthy();
  });

  it('starts from the customer’s stored support settings', () => {
    mount(customer({
      config: {
        support: {
          maintenanceProvider: 'aps',
          maintenanceOther: '',
          enterpriseSite: true,
          support24Hour: false,
        },
      },
    }));

    expect(screen.getByText('APS')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Enterprise Site' }).dataset.state).toBe('checked');
    expect(screen.getByRole('switch', { name: '24 Hour Support' }).dataset.state).toBe('unchecked');
  });

  it('shows the free-text box only when the provider is Other', () => {
    mount(customer({
      config: {
        support: {
          maintenanceProvider: 'other',
          maintenanceOther: 'Metro Facilities',
          enterpriseSite: false,
          support24Hour: false,
        },
      },
    }));

    expect(screen.getByDisplayValue('Metro Facilities')).toBeTruthy();
  });

  it('hides it for a named provider', () => {
    mount(customer({
      config: {
        support: {
          maintenanceProvider: 'ensight', maintenanceOther: '',
          enterpriseSite: false, support24Hour: false,
        },
      },
    }));

    expect(screen.queryByPlaceholderText('Enter maintenance provider')).toBeNull();
  });
});

// ── MAINTENANCE PROVIDER ────────────────────────────────────────────────────
describe('maintenance responsibility', () => {
  it('offers Not set, Ensight, APS and Other', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('combobox'));

    for (const label of ['Not set', 'Ensight', 'APS', 'Other']) {
      expect(await screen.findByRole('option', { name: label })).toBeTruthy();
    }
  });

  it('stores the chosen provider', async () => {
    const user = userEvent.setup();
    mount();

    await chooseProvider(user, 'Ensight');
    await save(user);

    await waitFor(() => expect(support().maintenanceProvider).toBe('ensight'));
  });

  it('reveals the free-text box when Other is chosen', async () => {
    const user = userEvent.setup();
    mount();

    await chooseProvider(user, 'Other');

    expect(await screen.findByPlaceholderText('Enter maintenance provider')).toBeTruthy();
  });

  it('stores the typed name, trimmed', async () => {
    const user = userEvent.setup();
    mount();

    await chooseProvider(user, 'Other');
    await user.type(screen.getByPlaceholderText('Enter maintenance provider'), '  Metro Facilities  ');
    await save(user);

    await waitFor(() => expect(support().maintenanceProvider).toBe('other'));
    expect(support().maintenanceOther).toBe('Metro Facilities');
  });

  it('clears a stale free-text name when the provider changes away from Other', async () => {
    const user = userEvent.setup();
    mount(customer({
      config: {
        support: {
          maintenanceProvider: 'other', maintenanceOther: 'Metro Facilities',
          enterpriseSite: false, support24Hour: false,
        },
      },
    }));

    await chooseProvider(user, 'APS');
    await save(user);

    // Leaving it behind would have the sheet name a provider nobody selected.
    await waitFor(() => expect(support().maintenanceProvider).toBe('aps'));
    expect(support().maintenanceOther).toBe('');
  });

  it('drops leftover free text the sheet already disagrees with', async () => {
    const user = userEvent.setup();
    // A row that names a provider AND carries an "other" name — reachable from
    // an import or a hand-edited sheet. Saving must reconcile it rather than
    // writing the contradiction straight back.
    mount(customer({
      config: {
        support: {
          maintenanceProvider: 'aps', maintenanceOther: 'Metro Facilities',
          enterpriseSite: false, support24Hour: false,
        },
      },
    }));

    await save(user);

    await waitFor(() => expect(sync.syncCustomerToSheet).toHaveBeenCalled());
    expect(support().maintenanceProvider).toBe('aps');
    expect(support().maintenanceOther).toBe('');
  });

  it('clears the provider entirely on Not set', async () => {
    const user = userEvent.setup();
    mount(customer({
      config: {
        support: {
          maintenanceProvider: 'aps', maintenanceOther: '',
          enterpriseSite: false, support24Hour: false,
        },
      },
    }));

    await chooseProvider(user, 'Not set');
    await save(user);

    await waitFor(() => expect(support().maintenanceProvider).toBe(''));
  });
});

// ── TOGGLES ─────────────────────────────────────────────────────────────────
describe('the support toggles', () => {
  it('turns Enterprise Site on from the switch', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: 'Enterprise Site' }));
    await save(user);

    await waitFor(() => expect(support().enterpriseSite).toBe(true));
  });

  it('turns 24 Hour Support on from the switch', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: '24 Hour Support' }));
    await save(user);

    await waitFor(() => expect(support().support24Hour).toBe(true));
  });

  it('toggles from the card as well as the switch', async () => {
    const user = userEvent.setup();
    mount();

    // The whole card is the target; the switch inside stops propagation so a
    // click on it cannot toggle twice and cancel itself out.
    await user.click(screen.getByRole('button', { name: /Enterprise Site/ }));

    expect(screen.getByRole('switch', { name: 'Enterprise Site' }).dataset.state).toBe('checked');
  });

  it('turns one off again without disturbing the other', async () => {
    const user = userEvent.setup();
    mount(customer({
      config: {
        support: {
          maintenanceProvider: '', maintenanceOther: '',
          enterpriseSite: true, support24Hour: true,
        },
      },
    }));

    await user.click(screen.getByRole('switch', { name: 'Enterprise Site' }));
    await save(user);

    await waitFor(() => expect(support().enterpriseSite).toBe(false));
    expect(support().support24Hour).toBe(true);
  });
});

// ── SAVING ──────────────────────────────────────────────────────────────────
describe('saving', () => {
  it('pushes the customer to the sheet with the new support values', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: 'Enterprise Site' }));
    await save(user);

    await waitFor(() => expect(sync.syncCustomerToSheet).toHaveBeenCalledTimes(1));
    expect(synced().config.support.enterpriseSite).toBe(true);
  });

  it('keeps the customer’s address — a support edit is not a config replacement', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: '24 Hour Support' }));
    await save(user);

    await waitFor(() => expect(support().support24Hour).toBe(true));
    expect(stored().config.address).toBe('100 Main St');
    expect(stored().config.city).toBe('Boston');
    expect(stored().config.zip).toBe('02110');
    // …and the sheet write carries them too, or the next sync blanks them.
    expect(synced().config.address).toBe('100 Main St');
  });

  it('closes once the sheet has taken it', async () => {
    const user = userEvent.setup();
    mount();

    await save(user);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

// ── FAILURE ─────────────────────────────────────────────────────────────────
describe('when the sheet write fails', () => {
  beforeEach(() => {
    sync.syncCustomerToSheet.mockRejectedValue(new Error('Rate limit exceeded'));
  });

  it('says so instead of closing as though it saved', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: 'Enterprise Site' }));
    await save(user);

    expect(await screen.findByText('Sheet sync failed')).toBeTruthy();
    expect(screen.getByText('Rate limit exceeded')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('keeps the local change so a retry has something to send', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: 'Enterprise Site' }));
    await save(user);

    await screen.findByText('Sheet sync failed');
    expect(support().enterpriseSite).toBe(true);
  });

  it('clears the error when the retry succeeds', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: 'Enterprise Site' }));
    await save(user);
    await screen.findByText('Sheet sync failed');

    sync.syncCustomerToSheet.mockResolvedValue(undefined);
    await save(user);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByText('Sheet sync failed')).toBeNull();
  });
});

// ── NO WRITABLE SHEET ───────────────────────────────────────────────────────
describe('a customer with no writable sheet', () => {
  it('saves locally and never calls the sync', async () => {
    const user = userEvent.setup();
    mount(customer({ spreadsheetId: null, sourceFileId: 'xlsx-1' }));

    await user.click(screen.getByRole('switch', { name: 'Enterprise Site' }));
    await save(user);

    await waitFor(() => expect(support().enterpriseSite).toBe(true));
    expect(sync.syncCustomerToSheet).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ── CANCEL ──────────────────────────────────────────────────────────────────
describe('cancelling', () => {
  it('changes nothing and writes nothing', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('switch', { name: 'Enterprise Site' }));
    await user.click(dialogButton(/^cancel$/i));

    expect(support().enterpriseSite).toBe(false);
    expect(sync.syncCustomerToSheet).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not carry the abandoned edit into the next open', async () => {
    const user = userEvent.setup();
    const cust = customer();
    const view = render(
      <CustomerSupportDialog customer={cust} open onOpenChange={onOpenChange} />,
    );
    useAppStore.setState({ customers: [cust], selectedCustomerId: 1 });

    await user.click(screen.getByRole('switch', { name: 'Enterprise Site' }));
    view.rerender(
      <CustomerSupportDialog customer={cust} open={false} onOpenChange={onOpenChange} />,
    );
    view.rerender(
      <CustomerSupportDialog customer={cust} open onOpenChange={onOpenChange} />,
    );

    expect(screen.getByRole('switch', { name: 'Enterprise Site' }).dataset.state)
      .toBe('unchecked');
  });
});
