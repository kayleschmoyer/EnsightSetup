import { describe, expect, it } from 'vitest';
import {
  nextCameraName,
  nextSignName,
  getLevelNamingNumber,
  compareCameraNames,
  assignDualLensStreamNames,
  applyDualLensNaming,
  defaultSecondStreamType,
  expandDevicesForSidebar,
  streamSyncSheetName,
} from './deviceNamingUtils';

describe('nextSignName', () => {
  it('produces S{level}.{seq} names', () => {
    expect(nextSignName(1, new Set())).toBe('S1.1');
    expect(nextSignName(2, new Set())).toBe('S2.1');
  });

  it('skips used names', () => {
    const used = new Set(['S1.1', 'S1.2']);
    expect(nextSignName(1, used)).toBe('S1.3');
  });
});

describe('getLevelNamingNumber', () => {
  it('prefers signDisplayOrdinal from level config', () => {
    expect(getLevelNamingNumber({
      id: 99,
      config: { signDisplayOrdinal: 1 },
      devices: [{ name: '5.1F' }],
    }, [{ id: 99 }])).toBe(1);
  });

  it('infers from existing device names when ordinals are missing', () => {
    expect(getLevelNamingNumber({
      id: 5,
      devices: [{ name: '1.1F' }, { name: '1.2F' }, { name: 'S1.1' }],
    }, [{ id: 1 }, { id: 5 }])).toBe(1);
  });

  it('falls back to 1-based garage order', () => {
    const levels = [{ id: 10 }, { id: 20 }, { id: 30 }];
    expect(getLevelNamingNumber({ id: 20, devices: [] }, levels)).toBe(2);
  });
});

describe('compareCameraNames with sign names', () => {
  it('sorts S-prefixed sign names numerically within a level', () => {
    const names = ['S1.10', 'S1.2', 'S1.1'];
    expect([...names].sort(compareCameraNames)).toEqual(['S1.1', 'S1.2', 'S1.10']);
  });

  it('still sorts camera names numerically', () => {
    const names = ['1.10F', '1.2F', '1.1F'];
    expect([...names].sort(compareCameraNames)).toEqual(['1.1F', '1.2F', '1.10F']);
  });
});

describe('nextCameraName', () => {
  it('keeps the {level}.{seq}{prefix} format', () => {
    expect(nextCameraName('F', 1, new Set(['1.1F']))).toBe('1.2F');
  });
});

describe('defaultSecondStreamType', () => {
  it('pairs FLI with LPR and LPR with FLI', () => {
    expect(defaultSecondStreamType('cam-fli')).toBe('cam-lpr');
    expect(defaultSecondStreamType('cam-lpr')).toBe('cam-fli');
  });
});

describe('assignDualLensStreamNames', () => {
  it('pairs mixed FLI + LPR streams on one sequence number', () => {
    const names = assignDualLensStreamNames(1, 'cam-fli', 'cam-lpr', new Set());
    expect(names).toEqual({
      deviceName: '1.1F',
      stream1SheetName: '1.1F',
      stream2SheetName: '1.1L',
    });
  });

  it('uses -S2 for same-type dual streams', () => {
    const names = assignDualLensStreamNames(1, 'cam-fli', 'cam-fli', new Set());
    expect(names).toEqual({
      deviceName: '1.1F',
      stream1SheetName: '1.1F',
      stream2SheetName: '1.1F-S2',
    });
  });

  it('preserves an imported camera sequence when converting to dual-lens', () => {
    const names = assignDualLensStreamNames(1, 'cam-fli', 'cam-lpr', new Set(['1.2F', '1.2L']), {
      existingName: '1.1F',
    });
    expect(names).toEqual({
      deviceName: '1.1F',
      stream1SheetName: '1.1F',
      stream2SheetName: '1.1L',
    });
  });

  it('preserves site-prefixed camera IDs like ENSA-WALLER-1.1F', () => {
    const names = assignDualLensStreamNames(
      1,
      'cam-fli',
      'cam-lpr',
      new Set(['ENSA-WALLER-1.2L']),
      { existingName: 'ENSA-WALLER-1.1F' },
    );
    expect(names).toEqual({
      deviceName: 'ENSA-WALLER-1.1F',
      stream1SheetName: 'ENSA-WALLER-1.1F',
      stream2SheetName: 'ENSA-WALLER-1.1L',
    });
  });

  it('restores site prefix when the short id was already mangled', () => {
    const names = assignDualLensStreamNames(
      1,
      'cam-fli',
      'cam-lpr',
      new Set(['ENSA-WALLER-1.2L']),
      { existingName: '1.1F' },
    );
    expect(names).toEqual({
      deviceName: 'ENSA-WALLER-1.1F',
      stream1SheetName: 'ENSA-WALLER-1.1F',
      stream2SheetName: 'ENSA-WALLER-1.1L',
    });
  });

  it('keeps stream 1 ID and uses -S2 when complementary ID is taken', () => {
    const names = assignDualLensStreamNames(1, 'cam-fli', 'cam-lpr', new Set(['1.1L']), {
      existingName: '1.1F',
    });
    expect(names).toEqual({
      deviceName: '1.1F',
      stream1SheetName: '1.1F',
      stream2SheetName: '1.1F-S2',
    });
  });
});

describe('applyDualLensNaming', () => {
  it('keeps imported name when converting FLI to dual-lens FLI+LPR', () => {
    const device = {
      id: 7,
      name: '1.1F',
      type: 'cam-fli',
      hardwareType: 'dual-lens',
      stream1: { streamType: 'cam-fli', ipAddress: '10.0.0.1' },
      stream2: { streamType: 'cam-lpr', ipAddress: '' },
    };
    const next = applyDualLensNaming(device, 1, [device], 7, { preserveName: true });
    expect(next.name).toBe('1.1F');
    expect(next.stream1.configSheetName).toBe('1.1F');
    expect(next.stream2.configSheetName).toBe('1.1L');
    expect(next.type).toBe('cam-fli');
  });

  it('keeps ENSA-WALLER prefixed IDs for both streams', () => {
    const device = {
      id: 7,
      name: 'ENSA-WALLER-1.1F',
      type: 'cam-fli',
      hardwareType: 'dual-lens',
      stream1: { streamType: 'cam-fli' },
      stream2: { streamType: 'cam-lpr' },
    };
    const siblings = [
      device,
      { id: 8, name: 'ENSA-WALLER-1.2L', type: 'cam-lpr' },
    ];
    const next = applyDualLensNaming(device, 1, siblings, 7, { preserveName: true });
    expect(next.name).toBe('ENSA-WALLER-1.1F');
    expect(next.stream1.configSheetName).toBe('ENSA-WALLER-1.1F');
    expect(next.stream2.configSheetName).toBe('ENSA-WALLER-1.1L');
  });

  it('allocates a new sequence when preserveName is false (copy)', () => {
    const source = {
      id: 7,
      name: '1.1F',
      type: 'cam-fli',
      hardwareType: 'dual-lens',
      stream1: { streamType: 'cam-fli', configSheetName: '1.1F' },
      stream2: { streamType: 'cam-lpr', configSheetName: '1.1L' },
    };
    const copy = {
      ...source,
      id: 8,
      stream1: { streamType: 'cam-fli' },
      stream2: { streamType: 'cam-lpr' },
    };
    const next = applyDualLensNaming(copy, 1, [source, copy], null, { preserveName: false });
    expect(next.name).toBe('1.2F');
    expect(next.stream2.configSheetName).toBe('1.2L');
  });
});

describe('expandDevicesForSidebar', () => {
  it('splits mixed-type dual-lens into FLI and LPR rows', () => {
    const rows = expandDevicesForSidebar([{
      id: 1,
      name: '1.1F',
      type: 'cam-fli',
      hardwareType: 'dual-lens',
      stream1: { streamType: 'cam-fli', configSheetName: '1.1F' },
      stream2: { streamType: 'cam-lpr', configSheetName: '1.1L' },
    }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sidebarName: '1.1F', groupType: 'cam-fli' });
    expect(rows[1]).toMatchObject({ sidebarName: '1.1L', groupType: 'cam-lpr' });
  });
});

describe('streamSyncSheetName', () => {
  it('returns per-stream sheet names for dual-lens', () => {
    const device = {
      name: '1.1F',
      hardwareType: 'dual-lens',
      stream1: { streamType: 'cam-fli', configSheetName: '1.1F' },
      stream2: { streamType: 'cam-lpr', configSheetName: '1.1L' },
    };
    expect(streamSyncSheetName(device, 1)).toBe('1.1F');
    expect(streamSyncSheetName(device, 2)).toBe('1.1L');
  });
});
