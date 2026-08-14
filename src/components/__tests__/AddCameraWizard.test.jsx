// @vitest-environment jsdom
/**
 * QA — AddCameraWizard: every step, every field, every button.
 *
 * The wizard is the only place a camera is created, and the shape it emits is
 * what every downstream writer keys off: `hardwareType` decides whether a
 * second stream row is written at all, `stream1.streamType` decides the
 * device's type (not the step-2 pick, which the user can still change), and the
 * traffic-flow block decides which level's counts the camera contributes to.
 * A wrong field here is not a cosmetic bug — it writes the wrong rows to the
 * sheet, and the camera silently counts for the wrong level.
 *
 * The component is self-contained: props in, `onAddCamera(device)` out. So the
 * assertions read the emitted device rather than the store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import AddCameraWizard from '../AddCameraWizard';

const LEVELS = [
  { id: 1, name: 'Level 1', zones: [{ id: 'z1', name: 'Ramp Zone' }] },
  { id: 2, name: 'Level 2', zones: [] },
];
const SERVERS = [
  { id: 7, name: 'Recorder A' },
  { id: 8, name: 'Recorder B' },
];

let onAddCamera;
let onOpenChange;

function mount(props = {}) {
  return render(
    <AddCameraWizard
      open
      onOpenChange={onOpenChange}
      levels={LEVELS}
      currentLevel={LEVELS[0]}
      servers={SERVERS}
      onAddCamera={onAddCamera}
      {...props}
    />,
  );
}

/** Fields are labelled by a sibling <Label>, not htmlFor. */
function field(labelText) {
  for (const label of screen.getAllByText(labelText, { exact: false })) {
    const input = label.parentElement?.querySelector('input, textarea');
    if (input) return input;
  }
  throw new Error(`no input for label "${labelText}"`);
}

/** Radix Select: open the trigger, then pick the option by its text. */
async function chooseOption(user, trigger, optionText) {
  await user.click(trigger);
  const option = await screen.findByRole('option', { name: optionText });
  await user.click(option);
}

/** The combobox sitting next to a given piece of prompt text. */
function selectNear(text) {
  const node = screen.getByText(text, { exact: false });
  return within(node.parentElement).getByRole('combobox');
}

const added = () => onAddCamera.mock.calls[0][0];

/**
 * Step-2 tiles render a DeviceIcon that draws its own letters, so the LPR tile's
 * accessible name is "LPLPR". Anchor on the end of the name instead.
 */
const streamTile = (label) => new RegExp(`${label}$`);

/** Walk step 1 → step 3, choosing hardware and (when asked) stream type. */
async function toConfig(user, hardwareLabel, streamLabel) {
  await user.click(screen.getByRole('button', { name: new RegExp(hardwareLabel, 'i') }));
  if (streamLabel) {
    await screen.findByText(/Select Type/);
    await user.click(screen.getByRole('button', { name: streamTile(streamLabel) }));
  }
  await screen.findByText('Add Camera — Configuration');
}

async function submit(user) {
  await user.click(screen.getByRole('button', { name: /^add camera$/i }));
}

beforeEach(() => {
  onAddCamera = vi.fn();
  onOpenChange = vi.fn();
});
afterEach(cleanup);

// ── STEP 1: HARDWARE TYPE ───────────────────────────────────────────────────
describe('step 1 — hardware type', () => {
  it('offers both hardware types with their stream counts', () => {
    mount();
    expect(screen.getByText('Bullet Camera')).toBeTruthy();
    expect(screen.getByText('Dual Lens Camera')).toBeTruthy();
    expect(screen.getByText('1 stream')).toBeTruthy();
    expect(screen.getByText('2 streams')).toBeTruthy();
  });

  it('goes to the stream-type step when the type is not already known', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('button', { name: /bullet camera/i }));

    expect(await screen.findByText(/Bullet Camera — Select Type/)).toBeTruthy();
  });

  it('skips the stream-type step when the caller already picked one', async () => {
    const user = userEvent.setup();
    mount({ initialStreamType: 'cam-lpr' });

    await user.click(screen.getByRole('button', { name: /bullet camera/i }));

    // Straight to configuration — no "Select Type" step in between.
    expect(await screen.findByText('Add Camera — Configuration')).toBeTruthy();
  });
});

// ── STEP 2: STREAM TYPE ─────────────────────────────────────────────────────
describe('step 2 — stream type', () => {
  it('offers FLI, LPR and People', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('button', { name: /bullet camera/i }));

    expect(await screen.findByRole('button', { name: streamTile('FLI') })).toBeTruthy();
    expect(screen.getByRole('button', { name: streamTile('LPR') })).toBeTruthy();
    expect(screen.getByRole('button', { name: streamTile('People') })).toBeTruthy();
  });

  it('goes back to hardware selection', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole('button', { name: /bullet camera/i }));
    await screen.findByText(/Select Type/);
    // The dialog is portalled, so it is not inside render()'s container.
    await user.click(document.body.querySelector('svg[class*="chevron-left"]').closest('button'));

    expect(await screen.findByText('Select Camera Type')).toBeTruthy();
  });

  it('lands on configuration with the chosen type applied', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'LPR');
    await submit(user);

    expect(added().type).toBe('cam-lpr');
  });
});

// ── HARDWARE SHAPE ──────────────────────────────────────────────────────────
describe('what each hardware type emits', () => {
  it('a bullet camera has one stream and no stream2', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await submit(user);

    expect(added().hardwareType).toBe('bullet');
    expect(added().stream1).toBeTruthy();
    expect(added().stream2).toBeUndefined();
  });

  it('a dual-lens camera defaults its second stream to the complementary type', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'dual lens camera', 'FLI');

    // The tabs name each stream's type, so they show the pairing directly.
    expect(screen.getByRole('button', { name: /Stream 1 · FLI/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stream 2 · LPR/ })).toBeTruthy();

    await submit(user);
    expect(added().hardwareType).toBe('dual-lens');
    expect(added().stream1.streamType).toBe('cam-fli');
    expect(added().stream2.streamType).toBe('cam-lpr');
  });

  it('pairs LPR with FLI the other way round', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'dual lens camera', 'LPR');
    await submit(user);

    expect(added().stream1.streamType).toBe('cam-lpr');
    expect(added().stream2.streamType).toBe('cam-fli');
  });

  it('leaves both streams as People when that is the pick', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'dual lens camera', 'People');
    await submit(user);

    expect(added().stream1.streamType).toBe('cam-people');
    expect(added().stream2.streamType).toBe('cam-people');
  });

  it('shows no stream tabs for a single-stream camera', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');

    expect(screen.queryByRole('button', { name: /Stream 1 ·/ })).toBeNull();
  });
});

// ── STEP 3: DEVICE FIELDS ───────────────────────────────────────────────────
describe('step 3 — device fields', () => {
  it('records name, friendly name and MAC address', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await user.type(field('Device Name'), 'F11');
    await user.type(field('Friendly Name'), 'North Entry FLI');
    await user.type(field('MAC Address'), '00:1A:2B:3C:4D:5E');
    await submit(user);

    expect(added().name).toBe('F11');
    expect(added().friendlyName).toBe('North Entry FLI');
    expect(added().macAddress).toBe('00:1A:2B:3C:4D:5E');
  });

  it('falls back to a placeholder name when left blank', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await submit(user);

    expect(added().name).toBe('Camera');
    expect(added().friendlyName).toBe('');
  });

  it('records the IP, port and RTSP URL, mirroring IP/port onto the device', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await user.type(field('IP Address'), '10.16.6.45');
    await user.clear(field('Port'));
    await user.type(field('Port'), '8554');
    await user.type(field('RTSP URL'), 'rtsp://10.16.6.45/live');
    await submit(user);

    expect(added().stream1.ipAddress).toBe('10.16.6.45');
    expect(added().stream1.port).toBe('8554');
    expect(added().stream1.externalUrl).toBe('rtsp://10.16.6.45/live');
    // Legacy consumers read these off the device, so they must agree.
    expect(added().ipAddress).toBe('10.16.6.45');
    expect(added().port).toBe('8554');
  });

  it('defaults the port to 554', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await submit(user);

    expect(added().stream1.port).toBe('554');
  });

  it('takes the device type from stream 1 after the type is changed in step 3', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    // Changing the toggle after step 2 must win — otherwise the device is
    // written with the type the user backed out of.
    await user.click(screen.getByRole('button', { name: 'People' }));
    await submit(user);

    expect(added().type).toBe('cam-people');
    expect(added().stream1.streamType).toBe('cam-people');
  });
});

// ── STEP 3: PER-STREAM ISOLATION ────────────────────────────────────────────
describe('step 3 — dual-lens streams stay separate', () => {
  it('keeps IP, port and RTSP per stream while name and MAC stay shared', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'dual lens camera', 'FLI');

    await user.type(field('Device Name'), 'F11');
    await user.type(field('MAC Address'), 'AA:BB:CC:DD:EE:FF');
    await user.type(field('IP Address'), '10.0.0.1');
    await user.type(field('Stream 1 RTSP URL'), 'rtsp://one');

    await user.click(screen.getByRole('button', { name: /Stream 2 ·/ }));

    // Device-level fields carry over; stream-level ones start clean.
    expect(field('Device Name').value).toBe('F11');
    expect(field('MAC Address').value).toBe('AA:BB:CC:DD:EE:FF');
    expect(field('IP Address').value).toBe('');
    expect(field('Stream 2 RTSP URL').value).toBe('');

    await user.type(field('IP Address'), '10.0.0.2');
    await user.type(field('Stream 2 RTSP URL'), 'rtsp://two');
    await submit(user);

    expect(added().stream1.ipAddress).toBe('10.0.0.1');
    expect(added().stream1.externalUrl).toBe('rtsp://one');
    expect(added().stream2.ipAddress).toBe('10.0.0.2');
    expect(added().stream2.externalUrl).toBe('rtsp://two');
  });

  it('changes only the active stream when the type toggle is used', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'dual lens camera', 'FLI');
    await user.click(screen.getByRole('button', { name: /Stream 2 ·/ }));
    await user.click(screen.getByRole('button', { name: 'People' }));
    await submit(user);

    expect(added().stream1.streamType).toBe('cam-fli');
    expect(added().stream2.streamType).toBe('cam-people');
  });
});

// ── STEP 3: TRAFFIC FLOW ────────────────────────────────────────────────────
describe('step 3 — traffic flow', () => {
  it('records the IN direction and defaults the level to the current one', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await user.click(screen.getByRole('button', { name: /^IN$/ }));
    await submit(user);

    expect(added().trafficFlow.direction).toBe('in');
    expect(added().stream1.direction).toBe('in');
    expect(added().trafficFlow.level).toBe('1');
  });

  it('records OUT, and pressing the same button again clears the direction', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    const out = screen.getByRole('button', { name: /^OUT$/ });
    await user.click(out);
    expect(out.getAttribute('aria-pressed')).toBe('true');

    await user.click(out);
    expect(out.getAttribute('aria-pressed')).toBe('false');

    await submit(user);
    expect(added().trafficFlow.direction).toBe('');
    // With no direction there is nothing to write on the stream row.
    expect(added().stream1.direction).toBeUndefined();
  });

  it('targets another level when one is chosen', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await user.click(screen.getByRole('button', { name: /^IN$/ }));
    await chooseOption(user, selectNear('Into level or zone:'), 'Level 2');
    await submit(user);

    expect(added().trafficFlow.level).toBe('2');
    expect(added().trafficFlow.zone).toBe('');
  });

  it('targets a zone on a level when one is chosen', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await chooseOption(user, selectNear('For level or zone:'), 'Ramp Zone');
    await submit(user);

    expect(added().trafficFlow.level).toBe('1');
    expect(added().trafficFlow.zone).toBe('z1');
  });

  it('records the opposite-flow destinations of a ramp camera', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await user.click(screen.getByRole('button', { name: /^IN$/ }));
    await user.click(screen.getByRole('switch', { name: /opposite flow/i }));
    await user.click(await screen.findByRole('button', { name: /^Level 2/ }));
    await submit(user);

    expect(added().trafficFlow.multiLevel).toBe(true);
    expect(added().trafficFlow.destinations).toEqual(['2']);
  });

  it('drops the destinations when the ramp switch is turned back off', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await user.click(screen.getByRole('button', { name: /^IN$/ }));
    const ramp = screen.getByRole('switch', { name: /opposite flow/i });
    await user.click(ramp);
    await user.click(await screen.findByRole('button', { name: /^Level 2/ }));
    await user.click(ramp);
    await submit(user);

    expect(added().trafficFlow.multiLevel).toBe(false);
    expect(added().trafficFlow.destinations).toEqual([]);
  });

  it('never counts the camera against its own primary target', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await user.click(screen.getByRole('button', { name: /^IN$/ }));
    await user.click(screen.getByRole('switch', { name: /opposite flow/i }));
    // Pick Level 2 as a destination, then move the primary target onto it —
    // leaving it in both places would have the camera count itself twice.
    await user.click(await screen.findByRole('button', { name: /^Level 2/ }));
    await chooseOption(user, selectNear('Into level or zone:'), 'Level 2');
    await submit(user);

    expect(added().trafficFlow.level).toBe('2');
    expect(added().trafficFlow.destinations).toEqual([]);
  });

  it('records where the traffic is coming from', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await chooseOption(user, selectNear('Coming from:'), 'Garage Entry');
    await submit(user);

    expect(added().trafficFlow.comingFrom).toBe('garage-entry');
  });

  it('offers other levels as a source but not the camera’s own', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await user.click(selectNear('Coming from:'));

    expect(await screen.findByRole('option', { name: 'Level 2' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Level 1' })).toBeNull();
  });

  it('keeps each dual-lens stream’s flow separate', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'dual lens camera', 'FLI');
    await user.click(screen.getByRole('button', { name: /^IN$/ }));

    await user.click(screen.getByRole('button', { name: /Stream 2 ·/ }));
    // Stream 2 starts with no direction of its own.
    expect(screen.getByRole('button', { name: /^IN$/ }).getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByRole('button', { name: /^OUT$/ }));
    await submit(user);

    expect(added().trafficFlow.direction).toBe('in');
    expect(added().stream2.trafficFlow.direction).toBe('out');
    expect(added().stream2.direction).toBe('out');
  });
});

// ── STEP 3: SERVER ──────────────────────────────────────────────────────────
describe('step 3 — server assignment', () => {
  it('assigns the chosen server by numeric id', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await chooseOption(user, selectNear('Server Assignment'), 'Recorder B');
    await submit(user);

    expect(added().serverId).toBe(8);
  });

  it('leaves the camera unassigned by default', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await submit(user);

    expect(added().serverId).toBeNull();
  });
});

// ── FOOTER ──────────────────────────────────────────────────────────────────
describe('footer', () => {
  it('has no footer buttons before the configuration step', () => {
    mount();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^add camera$/i })).toBeNull();
  });

  it('cancel closes without adding anything', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onAddCamera).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('adding closes the wizard too', async () => {
    const user = userEvent.setup();
    mount();

    await toConfig(user, 'bullet camera', 'FLI');
    await submit(user);

    expect(onAddCamera).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('starts over at step 1 after being cancelled', async () => {
    const user = userEvent.setup();
    const view = mount();

    await toConfig(user, 'dual lens camera', 'LPR');
    await user.type(field('Device Name'), 'F11');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    // Same instance re-opened: the previous entry must not leak into the next
    // camera, which would silently duplicate a MAC or a name.
    view.rerender(
      <AddCameraWizard
        open
        onOpenChange={onOpenChange}
        levels={LEVELS}
        currentLevel={LEVELS[0]}
        servers={SERVERS}
        onAddCamera={onAddCamera}
      />,
    );

    expect(await screen.findByText('Select Camera Type')).toBeTruthy();
  });
});
