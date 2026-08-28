import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  prefersNativeCameraCapture,
  readImageFilesAsDataUrls,
  isOversizedDevicePhoto,
  MAX_DEVICE_PHOTO_BYTES,
  MAX_DEVICE_PHOTO_DATA_URL_CHARS,
  MAX_SIGN_PHOTOS,
  compressOversizedDevicePhotos,
} from './photoPick';

const dataUrl = (chars) => `data:image/jpeg;base64,${'A'.repeat(chars)}`;
const oversized = dataUrl(MAX_DEVICE_PHOTO_DATA_URL_CHARS + 500);
const small = dataUrl(80);

describe('prefersNativeCameraCapture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is true for coarse pointer (phone/tablet)', () => {
    vi.stubGlobal('window', {
      matchMedia: (query) => ({
        matches: String(query).includes('pointer: coarse'),
        media: query,
      }),
    });
    vi.stubGlobal('navigator', { maxTouchPoints: 5 });
    expect(prefersNativeCameraCapture()).toBe(true);
  });

  it('is false for fine pointer desktop', () => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, media: '' }),
    });
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(prefersNativeCameraCapture()).toBe(false);
  });
});

describe('readImageFilesAsDataUrls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips non-image files', async () => {
    const text = new File(['hi'], 'note.txt', { type: 'text/plain' });
    await expect(readImageFilesAsDataUrls([text])).resolves.toEqual([]);
  });

  it('reads image files as data URLs', async () => {
    class FakeFileReader {
      result = null;
      onload = null;
      onerror = null;
      readAsDataURL(file) {
        const reader = this;
        queueMicrotask(() => {
          reader.result = `data:${file.type};base64,QQ==`;
          reader.onload?.();
        });
      }
    }
    vi.stubGlobal('FileReader', FakeFileReader);
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const urls = await readImageFilesAsDataUrls([file]);
    expect(urls).toEqual(['data:image/png;base64,QQ==']);
  });
});

describe('MAX_DEVICE_PHOTO_BYTES', () => {
  it('targets a ~500KB blob budget now that photos upload to Storage', () => {
    // Photos are uploaded as Storage blobs (see ImageUploadService.uploadDevicePhoto)
    // instead of embedded as base64 — the tight data-URL/Sheets-cell ceiling no longer applies.
    expect(MAX_DEVICE_PHOTO_BYTES).toBe(500_000);
  });
});

describe('device photo budgets', () => {
  it('flags oversized photos and caps sign count', () => {
    expect(isOversizedDevicePhoto(small)).toBe(false);
    expect(isOversizedDevicePhoto(oversized)).toBe(true);
    expect(MAX_SIGN_PHOTOS).toBeGreaterThan(0);
    expect(MAX_SIGN_PHOTOS).toBeLessThanOrEqual(20);
  });
});

describe('compressOversizedDevicePhotos', () => {
  it('leaves setups without oversized photos untouched', async () => {
    const input = [{
      id: 1,
      levels: [{
        id: 11,
        devices: [{ id: 1, signImages: [small], viewImage: small }],
      }],
    }];
    const compress = vi.fn();
    const result = await compressOversizedDevicePhotos(input, { compress });
    expect(result.sites).toBe(input);
    expect(result.compressed).toBe(0);
    expect(compress).not.toHaveBeenCalled();
  });

  it('recompresses viewImage and signImages past the budget', async () => {
    const input = [{
      id: 1,
      levels: [{
        id: 11,
        devices: [{
          id: 7,
          viewImage: oversized,
          signImages: [oversized, small],
        }],
      }],
    }];
    const compress = vi.fn().mockResolvedValue(small);
    const result = await compressOversizedDevicePhotos(input, { compress });

    expect(compress).toHaveBeenCalledTimes(2);
    expect(result.compressed).toBe(2);
    expect(result.sites[0].levels[0].devices[0].viewImage).toBe(small);
    expect(result.sites[0].levels[0].devices[0].signImages).toEqual([small, small]);
  });
});
