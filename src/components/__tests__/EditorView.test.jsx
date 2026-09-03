// @vitest-environment jsdom
/**
 * QA — EditorView: every control on the page.
 *
 * The canvas and inspector are replaced with harnesses that expose the
 * callbacks EditorView hands them as plain buttons. That keeps konva and the
 * 1200-line inspector out of the way while still driving EditorView's real
 * handlers — which is where devices get created, renamed and deleted, and where
 * the sheet syncs are fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const sync = vi.hoisted(() => ({
  syncCameraToSheet: vi.fn(async () => ({ configSheetNames: [] })),
  syncBulkCamerasToSheet: vi.fn(async (a) => a.devices),
  syncBulkSignsToSheet: vi.fn(async (a) => a.devices),
  syncBulkSensorsToSheet: vi.fn(async (a) => ({ devices: a.devices, garage: a.garage })),
  syncSensorToSheet: vi.fn(async () => null),
  syncSensorGroupsToSheet: vi.fn(async () => {}),
  syncDisplayGroupsToSheet: vi.fn(async () => {}),
  syncGarageLevelsToSheet: vi.fn(async () => {}),
  deleteCameraFromSheet: vi.fn(async () => {}),
  deleteSignFromSheet: vi.fn(async () => {}),
  deleteSensorFromSheet: vi.fn(async () => {}),
  deleteDevicesFromSheet: vi.fn(async () => {}),
  upsertDisplayGroupToSheet: vi.fn(async () => {}),
  syncSignGroupAssignmentToSheet: vi.fn(async () => {}),
  syncSignDisplayLevelsToSheet: vi.fn(async () => {}),
  syncSensorGroupAssignmentToSheet: vi.fn(async () => null),
  loadServersFromNetworkingTab: vi.fn(async () => []),
  loadDisplaySchedulesFromTab: vi.fn(async () => []),
  syncAllConfigTabsForCustomer: vi.fn(async () => ({ changedTabs: [] })),
  deviceAfterCameraSync: (d) => ({ ...d, configSheetName: d.name }),
}));

const harness = vi.hoisted(() => ({ inspector: null, canvas: null, wizard: null }));


vi.mock('../MapCanvas', () => ({
  default: (props) => {
    harness.canvas = props;
    return <div data-testid="map-canvas" />;
  },
}));

vi.mock('../InspectorPanel', () => ({
  default: (props) => {
    harness.inspector = props;
    return <div data-testid="inspector" />;
  },
}));

vi.mock('../AddCameraWizard', () => ({
  default: (props) => {
    harness.wizard = props;
    return props.open ? <div data-testid="camera-wizard" /> : null;
  },
}));

vi.mock('../ConfigEditor', () => ({ default: () => <div data-testid="config-editor" /> }));
vi.mock('../ReportIssueDialog', () => ({ default: (p) => (p.open ? <div data-testid="report-dialog" /> : null) }));
vi.mock('../AppSettingsDialog', () => ({ default: (p) => (p.open ? <div data-testid="settings-dialog" /> : null) }));
vi.mock('../../services/ConfigService', () => ({
  exportAllConfigs: vi.fn(),
  downloadFile: vi.fn(),
  readFileAsText: vi.fn(),
}));

const { useAppStore } = await import('../../stores/useAppStore');
const EditorView = (await import('../EditorView')).default;
const { exportAllConfigs } = await import('../../services/ConfigService');

const CUSTOMER_ID = 1;

function baseLevel(devices = [], zones = []) {
  return {
    id: 10, name: 'Level 1', internalName: 'Level 1',
    totalSpots: 100, evSpots: 0, handicapSpots: 0,
    devices, zones, config: {}, bgImage: null,
  };
}

function setStore({ devices = [], zones = [], canSync = true, selected = null } = {}) {
  const site = {
    id: 1, name: 'North', internalName: 'North',
    levels: [baseLevel(devices, zones)],
    displayGroups: [], sensorGroups: [], servers: [], mdfIdfLocations: [],
  };
  useAppStore.setState({
    customers: [{
      id: CUSTOMER_ID, customerId: 'acme', code: 'ACME', friendlyName: 'Acme',
      ...(canSync ? { spreadsheetId: 'sheet-1' } : {}),
      sites: [site], config: {},
    }],
    selectedCustomerId: CUSTOMER_ID,
    selectedSiteId: 1,
    selectedLevelId: 10,
    // The inspector only mounts for a selected device, which is how its
    // callbacks become reachable.
    selectedDevice: selected,
    currentView: 'editor',
    hydration: { [CUSTOMER_ID]: 'hydrated' },
    pendingRoute: null,
  });
}

/** Devices currently on the level, straight from the store. */
function levelDevices() {
  return useAppStore.getState().customers[0].sites[0].levels[0].devices;
}
function levelZones() {
  return useAppStore.getState().customers[0].sites[0].levels[0].zones || [];
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.inspector = null;
  harness.canvas = null;
  harness.wizard = null;
  setStore();
});

afterEach(cleanup);

// ── ADD TOOLBAR ─────────────────────────────────────────────────────────────
describe('Add toolbar', () => {
  const CAMERA_BUTTONS = ['Add FLI Camera', 'Add LPR Camera', 'Add People Counting'];
  const SIGN_BUTTONS = ['Add LED Sign', 'Add Static Sign', 'Add Designable Sign'];
  const SENSOR_BUTTONS = ['Add NWAVE', 'Add Parksol', 'Add Proco', 'Add Ensight Vision'];

  it('offers a button for every device type', () => {
    render(<EditorView />);
    for (const label of [...CAMERA_BUTTONS, ...SIGN_BUTTONS, ...SENSOR_BUTTONS]) {
      expect(screen.getByLabelText(label), `missing "${label}"`).toBeTruthy();
    }
  });

  it.each(CAMERA_BUTTONS)('%s opens the camera wizard rather than adding blindly', async (label) => {
    const user = userEvent.setup();
    render(<EditorView />);

    await user.click(screen.getByLabelText(label));

    // Cameras need a name and stream setup, so they go through the wizard.
    expect(screen.getByTestId('camera-wizard')).toBeTruthy();
    expect(levelDevices()).toHaveLength(0);
  });

  it.each(SIGN_BUTTONS)('%s adds a sign to the level', async (label) => {
    const user = userEvent.setup();
    render(<EditorView />);

    await user.click(screen.getByLabelText(label));

    await waitFor(() => expect(levelDevices()).toHaveLength(1));
    const added = levelDevices()[0];
    expect(added.type).toMatch(/^sign-/);
    expect(added.name).toBeTruthy();
    // Persistence is the store auto-save now — never the legacy sheet sync.
    expect(sync.syncBulkSignsToSheet).not.toHaveBeenCalled();
  });

  it.each(SENSOR_BUTTONS)('%s adds a sensor with a protocol sensor group assigned', async (label) => {
    const user = userEvent.setup();
    render(<EditorView />);

    await user.click(screen.getByLabelText(label));

    await waitFor(() => expect(levelDevices()).toHaveLength(1));
    const added = levelDevices()[0];
    expect(added.type).toMatch(/^sensor-/);
    // The group assignment used to happen inside the sheet-sync path; it must
    // still happen locally so the sensor lands in a SensorGroups row.
    expect(added.configSensorGroupId).toBeTruthy();
    const groups = useAppStore.getState().customers[0].sites[0].sensorGroups;
    expect(groups.some((g) => g.id === added.configSensorGroupId)).toBe(true);
    expect(sync.syncSensorToSheet).not.toHaveBeenCalled();
  });

  it('gives each added sign a distinct name', async () => {
    const user = userEvent.setup();
    render(<EditorView />);

    await user.click(screen.getByLabelText('Add LED Sign'));
    await waitFor(() => expect(levelDevices()).toHaveLength(1));
    await user.click(screen.getByLabelText('Add LED Sign'));
    await waitFor(() => expect(levelDevices()).toHaveLength(2));

    const [a, b] = levelDevices();
    expect(a.name).not.toBe(b.name);
  });

  it('adds a zone', async () => {
    const user = userEvent.setup();
    render(<EditorView />);

    await user.click(screen.getByLabelText('Add zone'));

    await waitFor(() => expect(levelZones()).toHaveLength(1));
    const poly = levelZones()[0];
    expect(poly.linkedLevelId).toBeTruthy();
    expect(poly.name).toBe('Zone 1');

    const allLevels = useAppStore.getState().customers[0].sites[0].levels;
    const zoneLevel = allLevels.find((l) => l.id === poly.linkedLevelId);
    expect(zoneLevel).toMatchObject({
      name: 'Zone 1',
      isZone: true,
      parentLevelId: 10,
    });
    expect(sync.syncGarageLevelsToSheet).not.toHaveBeenCalled();
  });
});

// ── DEVICE UPDATE / DELETE (via the inspector's callbacks) ──────────────────
describe('device update and delete', () => {
  const CAMERA = {
    id: 'cam-1', type: 'cam-fli', name: '1.1F', x: 10, y: 20,
    ipAddress: '10.0.0.1', pendingPlacement: false,
  };

  it('UPDATE writes the change into the store', async () => {
    setStore({ devices: [CAMERA], selected: CAMERA });
    render(<EditorView />);

    await harness.inspector.onUpdateDevice('cam-1', { ipAddress: '10.9.9.9' });

    await waitFor(() => expect(levelDevices()[0].ipAddress).toBe('10.9.9.9'));
  });

  it('UPDATE never touches the legacy sheet sync, even with syncToSheet', async () => {
    setStore({ devices: [CAMERA], selected: CAMERA });
    render(<EditorView />);

    await harness.inspector.onUpdateDevice('cam-1', { ipAddress: '10.9.9.9' }, { syncToSheet: true });

    await waitFor(() => expect(levelDevices()[0].ipAddress).toBe('10.9.9.9'));
    expect(sync.syncCameraToSheet).not.toHaveBeenCalled();
  });

  it('DELETE asks for confirmation before removing anything', async () => {
    setStore({ devices: [CAMERA], selected: CAMERA });
    render(<EditorView />);

    harness.inspector.onDeleteDevice('cam-1');

    // Still present until confirmed.
    await waitFor(() => expect(screen.getByText(/permanently delete/i)).toBeTruthy());
    expect(levelDevices()).toHaveLength(1);
  });

  it('DELETE removes the device once confirmed', async () => {
    const user = userEvent.setup();
    setStore({ devices: [CAMERA], selected: CAMERA });
    render(<EditorView />);

    harness.inspector.onDeleteDevice('cam-1');
    await waitFor(() => expect(screen.getByText(/permanently delete/i)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(levelDevices()).toHaveLength(0));
    expect(sync.deleteCameraFromSheet).not.toHaveBeenCalled();
  });

  it('UNPLACE keeps the device but takes it off the map', async () => {
    const user = userEvent.setup();
    setStore({ devices: [CAMERA], selected: CAMERA });
    render(<EditorView />);

    harness.inspector.onRemoveDevice('cam-1');
    await waitFor(() => expect(screen.getByText(/unplace/i)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(levelDevices()[0].pendingPlacement).toBe(true));
    // Unplacing is a map action, not a config change — the row stays.
    expect(sync.deleteCameraFromSheet).not.toHaveBeenCalled();
  });

  it('deleting a sensor prunes its now-unused sensor group', async () => {
    const user = userEvent.setup();
    const sensorDevice = {
      id: 'sen-1', type: 'sensor-nwave', name: 'SEN-1', x: 1, y: 1,
      configSensorGroupId: 'grp-1',
    };
    setStore({ devices: [sensorDevice], selected: sensorDevice });
    useAppStore.setState((state) => ({
      customers: state.customers.map((c) => ({
        ...c,
        sites: c.sites.map((g) => ({
          ...g,
          sensorGroups: [{ id: 'grp-1', groupId: 'NWAVE', sensorProtocol: 'NWAVE' }],
        })),
      })),
    }));
    render(<EditorView />);

    harness.inspector.onDeleteDevice('sen-1');
    await waitFor(() => expect(screen.getByText(/permanently delete/i)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(levelDevices()).toHaveLength(0));
    const groups = useAppStore.getState().customers[0].sites[0].sensorGroups;
    expect(groups).toHaveLength(0);
  });

  it('bulk delete removes every selected device', async () => {
    const user = userEvent.setup();
    const devices = [
      { id: 'cam-1', type: 'cam-fli', name: '1.1F', x: 10, y: 20, pendingPlacement: false },
      { id: 's-1', type: 'sign-static', name: 'S1.1', x: 1, y: 1, pendingPlacement: false },
      { id: 'sen-1', type: 'sensor-nwave', name: 'SEN-1', x: 2, y: 2, pendingPlacement: false },
    ];
    setStore({ devices });
    render(<EditorView />);

    await user.click(screen.getByRole('checkbox', { name: 'Select 1.1F' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select S1.1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select SEN-1' }));
    await user.click(screen.getByRole('button', { name: /Delete \(3\)/i }));
    await waitFor(() => expect(screen.getByText(/permanently delete 3 selected/i)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(levelDevices()).toHaveLength(0));
    expect(sync.deleteDevicesFromSheet).not.toHaveBeenCalled();
  });
});

// ── MAP INTERACTIONS ────────────────────────────────────────────────────────
describe('map', () => {
  const CAMERA = { id: 'cam-1', type: 'cam-fli', name: '1.1F', x: 10, y: 20 };

  it('dragging a device stores its new position', async () => {
    setStore({ devices: [CAMERA], selected: CAMERA });
    render(<EditorView />);

    await harness.canvas.onUpdateDevice('cam-1', { x: 300, y: 400 });

    await waitFor(() => {
      const d = levelDevices()[0];
      expect([d.x, d.y]).toEqual([300, 400]);
    });
  });

  it('moving a device on the map does not rewrite its config row', async () => {
    setStore({ devices: [CAMERA], selected: CAMERA });
    render(<EditorView />);

    await harness.canvas.onUpdateDevice('cam-1', { x: 300, y: 400 });

    await waitFor(() => expect(levelDevices()[0].x).toBe(300));
    // Position lives in the layout snapshot, not the Cameras tab.
    expect(sync.syncCameraToSheet).not.toHaveBeenCalled();
  });

  it('selecting a device on the map opens it in the inspector', async () => {
    setStore({ devices: [CAMERA], selected: CAMERA });
    render(<EditorView />);

    harness.canvas.onSelectDevice(CAMERA);

    await waitFor(() => expect(useAppStore.getState().selectedDevice?.id).toBe('cam-1'));
  });
});

// ── ZONES ───────────────────────────────────────────────────────────────────
describe('zones', () => {
  it('updates a zone through the canvas', async () => {
    const user = userEvent.setup();
    render(<EditorView />);
    await user.click(screen.getByLabelText('Add zone'));
    await waitFor(() => expect(levelZones()).toHaveLength(1));

    const zone = levelZones()[0];
    await harness.canvas.onUpdateZone(zone.id, { name: 'Renamed Zone' });

    await waitFor(() => expect(levelZones()[0].name).toBe('Renamed Zone'));
    const zoneLevel = useAppStore.getState().customers[0].sites[0].levels
      .find((l) => l.id === zone.linkedLevelId);
    expect(zoneLevel?.name).toBe('Renamed Zone');
  });
});

// ── TOOLBAR ─────────────────────────────────────────────────────────────────
describe('toolbar', () => {
  it('exports configs when the level has devices', async () => {
    const user = userEvent.setup();
    setStore({ devices: [{ id: 'cam-1', type: 'cam-fli', name: '1.1F', x: 1, y: 1 }] });
    render(<EditorView />);

    await user.click(screen.getByLabelText('Export config'));

    await waitFor(() => expect(exportAllConfigs).toHaveBeenCalled());
  });

  it('does not export an empty level', async () => {
    const user = userEvent.setup();
    render(<EditorView />);

    await user.click(screen.getByLabelText('Export config'));

    expect(exportAllConfigs).not.toHaveBeenCalled();
    expect(screen.getByText(/no devices to export/i)).toBeTruthy();
  });

  it('opens app settings', async () => {
    const user = userEvent.setup();
    render(<EditorView />);

    await user.click(screen.getByLabelText('App settings'));

    await waitFor(() => expect(screen.getByTestId('settings-dialog')).toBeTruthy());
  });

  it('opens the report-issue dialog', async () => {
    const user = userEvent.setup();
    render(<EditorView />);

    await user.click(screen.getByLabelText('Report issue or request'));

    await waitFor(() => expect(screen.getByTestId('report-dialog')).toBeTruthy());
  });

  it('goes back to the customer list', async () => {
    const user = userEvent.setup();
    render(<EditorView />);

    await user.click(screen.getByLabelText('Home — Customers'));

    await waitFor(() => expect(useAppStore.getState().currentView).toBe('customers'));
  });
});
