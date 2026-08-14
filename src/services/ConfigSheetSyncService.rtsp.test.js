import { describe, expect, it } from 'vitest';
import {
  expandCameraSyncEntries,
  getRtspUrlForStream,
} from './ConfigSheetSyncService';

describe('getRtspUrlForStream', () => {
  it('keeps stream 1 and stream 2 RTSP URLs independent', () => {
    const device = {
      name: '1.1',
      hardwareType: 'dual-lens',
      type: 'cam-fli',
      ipAddress: '10.0.0.1',
      rtspUrl: 'rtsp://stream1-only',
      stream1: {
        ipAddress: '10.0.0.1',
        port: '554',
        externalUrl: 'rtsp://stream1-only',
        streamType: 'cam-fli',
      },
      stream2: {
        ipAddress: '10.0.0.2',
        port: '554',
        externalUrl: 'rtsp://stream2-only',
        streamType: 'cam-lpr',
      },
    };

    expect(getRtspUrlForStream(device, device.stream1, 'stream1')).toBe('rtsp://stream1-only');
    expect(getRtspUrlForStream(device, device.stream2, 'stream2')).toBe('rtsp://stream2-only');
  });

  it('does not copy device.rtspUrl onto an empty stream 2', () => {
    const device = {
      name: '1.1',
      hardwareType: 'dual-lens',
      type: 'cam-fli',
      rtspUrl: 'rtsp://from-stream1',
      stream1: {
        ipAddress: '10.0.0.1',
        externalUrl: 'rtsp://from-stream1',
        streamType: 'cam-fli',
      },
      stream2: {
        ipAddress: '10.0.0.2',
        externalUrl: '',
        streamType: 'cam-lpr',
      },
    };

    const stream2Url = getRtspUrlForStream(device, device.stream2, 'stream2');
    expect(stream2Url).not.toBe('rtsp://from-stream1');
    expect(stream2Url).toContain('10.0.0.2');
  });
});

describe('expandCameraSyncEntries dual-lens', () => {
  it('attaches distinct streamKeys so sheet rows stay separated', () => {
    const device = {
      name: '1.1',
      hardwareType: 'dual-lens',
      type: 'cam-fli',
      rtspUrl: 'rtsp://shared-legacy',
      stream1: { externalUrl: 'rtsp://a', streamType: 'cam-fli' },
      stream2: { externalUrl: 'rtsp://b', streamType: 'cam-lpr' },
    };

    const entries = expandCameraSyncEntries(device);
    expect(entries).toHaveLength(2);
    expect(entries[0].streamKey).toBe('stream1');
    expect(entries[1].streamKey).toBe('stream2');
    expect(getRtspUrlForStream(device, entries[0].stream, entries[0].streamKey)).toBe('rtsp://a');
    expect(getRtspUrlForStream(device, entries[1].stream, entries[1].streamKey)).toBe('rtsp://b');
  });
});
