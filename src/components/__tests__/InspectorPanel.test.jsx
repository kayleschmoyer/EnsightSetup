// @vitest-environment jsdom
/**
 * QA — InspectorPanel: every field and every button.
 *
 * This is where nearly every device field is edited, so the assertion that
 * matters is not just "the input works" but *where the value goes*: which
 * fields reach the config tabs and which are map-only and must never trigger a
 * write. Getting that boundary wrong is either a lost edit or a pointless
 * rewrite of a tab on every mouse drag.
 *
 * Labels here are siblings of their inputs rather than tied by htmlFor, so
 * fields are located through the label's container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/ConfigService', () => ({
  generateCameraHubConfig: vi.fn(() => '{}'),
  generateDevicesConfig: vi.fn(() => '{}'),
  generateFLICameraConfig: vi.fn(() => '{}'),
  downloadFile: vi.fn(),
}));
vi.mock('../GroupAssignmentSelect', () => ({
  default: ({ onChange, label }) => (
    <button type="button" aria-label={`assign-${label || 'group'}`} onClick={() => onChange(99)}>
      assign
    </button>
  ),
}));
vi.mock('../DisplayLevelSelect', () => ({
  default: ({ onSiteChange }) => (
    <button type="button" aria-label="assign-display-levels" onClick={() => onSiteChange(1)}>
      levels
    </button>
  ),
}));

const InspectorPanel = (await import('../InspectorPanel')).default;

const CAMERA = {
  id: 'cam-1', type: 'cam-fli', name: '1.1F', friendlyName: 'Entry Cam',
  x: 10, y: 20, rotation: 0, ipAddress: '10.0.0.1', port: '554',
  hardwareType: 'bullet', pendingPlacement: false,
};
const SIGN = {
  id: 'sign-1', type: 'sign-static', name: 'S1.1', friendlyName: 'Entry Sign',
  controllerName: 'Entry Sign', visibleName: 'Entry Sign',
  x: 5, y: 6, ipAddress: '10.0.2.1', port: '10001', serialAddress: '3',
};
const SENSOR = {
  id: 'sen-1', type: 'sensor-nwave', name: 'SEN-1', x: 1, y: 2, sensorCount: 4,
};

let props;

function setup(device = CAMERA, overrides = {}) {
  props = {
    device,
    onUpdateDevice: vi.fn(),
    onCommitDeviceToSheet: vi.fn(),
    onCopyDevice: vi.fn(),
    onRemoveDevice: vi.fn(),
    onDeleteDevice: vi.fn(),
    onPlaceDevice: vi.fn(),
    onClose: vi.fn(),
    onToast: vi.fn(),
    servers: [{ id: 1, name: 'SRV-1' }],
    displayGroups: [{ id: 3, name: 'Grp' }],
    sensorGroups: [{ id: 4, groupId: 'G1', sensorProtocol: 'NWAVE' }],
    mdfIdfLocations: [{ id: 2, name: 'IDF-1' }],
    sites: [{ id: 1, name: 'North', levels: [{ id: 10, name: 'Level 1' }] }],
    levels: [{ id: 10, name: 'Level 1' }],
    currentLevel: { id: 10, name: 'Level 1', devices: [device] },
    deviceTypes: {
      cameras: [{ id: 'cam-fli', name: 'FLI Camera' }, { id: 'cam-lpr', name: 'LPR Camera' }],
      signs: [{ id: 'sign-led', name: 'LED Sign' }, { id: 'sign-static', name: 'Static Sign' }],
      sensorGroups: [{ id: 'sensor-nwave', name: 'NWAVE' }],
      hardwareTypes: [{ id: 'dual-lens', name: 'Dual Lens' }, { id: 'bullet', name: 'Bullet' }],
      parkingTypes: [],
    },
    canSyncToSheet: true,
    ...overrides,
  };
  render(<InspectorPanel {...props} />);
  return props;
}

/** Inputs are labelled by a sibling <Label>, not by htmlFor. */
function field(labelText) {
  const label = screen.getByText(labelText);
  const input = label.parentElement?.querySelector('input, textarea');
  if (!input) throw new Error(`no input found for label "${labelText}"`);
  return input;
}
function hasField(labelText) {
  return screen.queryAllByText(labelText).length > 0;
}
async function openTab(user, name) {
  await user.click(screen.getByRole('tab', { name }));
}

/** Every onUpdateDevice call that asked for a sheet write. */
function syncingCalls() {
  return props.onUpdateDevice.mock.calls.filter(([, , opts]) => opts?.syncToSheet);
}

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

// ── FIELDS PRESENT ──────────────────────────────────────────────────────────
describe('fields shown per device type', () => {
  it('a camera shows its identity, network and traffic fields', async () => {
    const user = userEvent.setup();
    setup(CAMERA);

    expect(hasField('Friendly Name')).toBe(true);
    expect(hasField('Camera Type')).toBe(true);
    expect(hasField('Hardware Type')).toBe(true);

    await openTab(user, /network/i);
    expect(hasField('IP Address')).toBe(true);
    expect(hasField('Port')).toBe(true);
    expect(hasField('RTSP URL')).toBe(true);
  });

  it('a sign shows display fields and a serial address, not camera ones', async () => {
    const user = userEvent.setup();
    setup(SIGN);

    expect(hasField('Display Name')).toBe(true);
    expect(hasField('Display Controller Name')).toBe(true);
    expect(hasField('Visible Display Name')).toBe(true);
    expect(hasField('Display Protocol')).toBe(true);
    expect(hasField('Camera Type')).toBe(false);

    await openTab(user, /network/i);
    expect(hasField('Serial Address')).toBe(true);
    expect(hasField('RTSP URL')).toBe(false);
  });

  it('a sensor shows sensor fields and no network tab', () => {
    setup(SENSOR);

    expect(hasField('Sensor Protocol')).toBe(true);
    expect(hasField('Sensor Count')).toBe(true);
    expect(screen.queryByRole('tab', { name: /network/i })).toBeNull();
  });
});

// ── FIELDS THAT MUST REACH THE SHEET ────────────────────────────────────────
describe('fields that write to the config tabs', () => {
  it('IP address commits on blur', async () => {
    const user = userEvent.setup();
    setup(CAMERA);
    await openTab(user, /network/i);

    await user.clear(field('IP Address'));
    await user.type(field('IP Address'), '10.9.9.9');
    await user.tab();

    expect(props.onUpdateDevice).toHaveBeenCalled();
    await waitFor(() => expect(props.onCommitDeviceToSheet).toHaveBeenCalledWith('cam-1'));
  });

  it('port commits on blur', async () => {
    const user = userEvent.setup();
    setup(CAMERA);
    await openTab(user, /network/i);

    await user.clear(field('Port'));
    await user.type(field('Port'), '8554');
    await user.tab();

    await waitFor(() => expect(props.onCommitDeviceToSheet).toHaveBeenCalled());
  });

  it('RTSP URL commits on blur', async () => {
    const user = userEvent.setup();
    setup(CAMERA);
    await openTab(user, /network/i);

    await user.type(field('RTSP URL'), 'rtsp://x/y');
    await user.tab();

    await waitFor(() => expect(props.onCommitDeviceToSheet).toHaveBeenCalled());
  });

  it('a sign serial address commits on blur', async () => {
    const user = userEvent.setup();
    setup(SIGN);
    await openTab(user, /network/i);

    await user.clear(field('Serial Address'));
    await user.type(field('Serial Address'), 'COM3');
    await user.tab();

    await waitFor(() => expect(props.onCommitDeviceToSheet).toHaveBeenCalled());
  });

  it('a legacy free-text server name commits on blur', async () => {
    const user = userEvent.setup();
    // Free text is only offered for a server recorded by name with no id —
    // the shape older imports produced.
    setup({ ...CAMERA, server: 'SRV-OLD', serverId: undefined });

    const input = field('Server Assignment');
    await user.clear(input);
    await user.type(input, 'SRV-1');
    await user.tab();

    expect(props.onUpdateDevice.mock.calls.some(([, u]) => 'server' in u)).toBe(true);
    await waitFor(() => expect(props.onCommitDeviceToSheet).toHaveBeenCalled());
  });

  it('offers the server list as a picker when there is no legacy name', () => {
    setup({ ...CAMERA, server: '' });

    // A picker, not free text, so the name always matches a real server.
    const label = screen.getByText('Server Assignment');
    expect(label.parentElement.querySelector('input')).toBeNull();
    expect(within(label.parentElement).getByRole('combobox')).toBeTruthy();
  });

  it('the disabled toggle syncs immediately', async () => {
    const user = userEvent.setup();
    setup(CAMERA);

    await user.click(screen.getByRole('switch'));

    const call = syncingCalls().at(-1);
    expect(call[1]).toHaveProperty('disabled');
    expect(call[2].syncToSheet).toBe(true);
  });

  it('a sign controller name syncs immediately', async () => {
    const user = userEvent.setup();
    setup(SIGN);

    await user.type(field('Display Controller Name'), 'X');

    expect(syncingCalls().some(([, u]) => 'controllerName' in u)).toBe(true);
  });

  it('a sign visible name syncs immediately', async () => {
    const user = userEvent.setup();
    setup(SIGN);

    await user.type(field('Visible Display Name'), 'X');

    expect(syncingCalls().some(([, u]) => 'visibleName' in u)).toBe(true);
  });
});

// ── MAP-ONLY FIELDS MUST NOT WRITE ──────────────────────────────────────────
describe('map-only fields never touch the sheet', () => {
  it.each([
    ['X', '55'],
    ['Y', '66'],
    ['Rotation', '90'],
  ])('%s updates locally without a sheet write', async (label, value) => {
    const user = userEvent.setup();
    setup(CAMERA);

    const input = field(label);
    await user.clear(input);
    await user.type(input, value);
    await user.tab();

    expect(props.onUpdateDevice).toHaveBeenCalled();
    // Position and rotation live in the layout snapshot, not a config tab.
    expect(syncingCalls()).toHaveLength(0);
    expect(props.onCommitDeviceToSheet).not.toHaveBeenCalled();
  });
});

// ── NAME COUPLING ───────────────────────────────────────────────────────────
describe('sign display name', () => {
  it('carries the controller and visible names along while they still match', async () => {
    const user = userEvent.setup();
    setup(SIGN);

    await user.type(field('Display Name'), '!');

    const updates = props.onUpdateDevice.mock.calls.at(-1)[1];
    expect(updates).toHaveProperty('friendlyName');
    expect(updates).toHaveProperty('controllerName');
    expect(updates).toHaveProperty('visibleName');
  });

  it('leaves a controller name the user has already customised alone', async () => {
    const user = userEvent.setup();
    setup({ ...SIGN, controllerName: 'CUSTOM-CTRL', visibleName: 'CUSTOM-VIS' });

    await user.type(field('Display Name'), '!');

    const updates = props.onUpdateDevice.mock.calls.at(-1)[1];
    expect(updates).toHaveProperty('friendlyName');
    expect(updates).not.toHaveProperty('controllerName');
    expect(updates).not.toHaveProperty('visibleName');
  });
});

// ── FOOTER BUTTONS ──────────────────────────────────────────────────────────
describe('footer buttons', () => {
  it('Unplace asks the parent to unplace', async () => {
    const user = userEvent.setup();
    setup(CAMERA);

    await user.click(screen.getByRole('button', { name: /unplace/i }));

    expect(props.onRemoveDevice).toHaveBeenCalledWith('cam-1');
  });

  it('Unplace is disabled for a device that is already unplaced', () => {
    setup({ ...CAMERA, pendingPlacement: true });
    expect(screen.getByRole('button', { name: /unplace/i }).disabled).toBe(true);
  });

  it('Duplicate copies the device', async () => {
    const user = userEvent.setup();
    setup(CAMERA);

    await user.click(screen.getByTitle('Duplicate device'));

    expect(props.onCopyDevice).toHaveBeenCalledWith('cam-1');
  });

  it('Delete asks the parent to delete', async () => {
    const user = userEvent.setup();
    setup(CAMERA);

    await user.click(screen.getByTitle('Permanently delete device'));

    expect(props.onDeleteDevice).toHaveBeenCalledWith('cam-1');
  });

  it('Close closes the panel', async () => {
    const user = userEvent.setup();
    setup(CAMERA);

    await user.click(screen.getByTitle('Close'));

    expect(props.onClose).toHaveBeenCalled();
  });

  it('Place on map is offered only for an unplaced device', async () => {
    const user = userEvent.setup();
    setup({ ...CAMERA, pendingPlacement: true });

    const place = screen.getByRole('button', { name: /place on map/i });
    await user.click(place);

    expect(props.onPlaceDevice).toHaveBeenCalledWith('cam-1');
  });
});

// ── NO SHEET LINKED ─────────────────────────────────────────────────────────
describe('when the customer has no writable sheet', () => {
  it('never asks for a sheet write, however the field is edited', async () => {
    const user = userEvent.setup();
    setup(CAMERA, { canSyncToSheet: false });

    await user.click(screen.getByRole('switch'));
    await openTab(user, /network/i);
    await user.type(field('IP Address'), '1');
    await user.tab();

    expect(syncingCalls()).toHaveLength(0);
    expect(props.onCommitDeviceToSheet).not.toHaveBeenCalled();
    // Local edits still land, so nothing is silently swallowed.
    expect(props.onUpdateDevice).toHaveBeenCalled();
  });
});

// ── GROUP ASSIGNMENT ────────────────────────────────────────────────────────
describe('group assignment', () => {
  it('assigning a sensor group syncs it', async () => {
    const user = userEvent.setup();
    setup(SENSOR);

    const assign = screen.getAllByRole('button', { name: /^assign-/ })[0];
    await user.click(assign);

    expect(syncingCalls().length).toBeGreaterThan(0);
  });
});
