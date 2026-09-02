import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
  uploadSetupAppImage: vi.fn(),
  deleteSetupAppImage: vi.fn(),
}));

const supabaseStorageMock = vi.hoisted(() => ({
  remove: vi.fn(async () => ({ error: null })),
  createSignedUrl: vi.fn(async (path) => ({
    data: { signedUrl: `https://supabase.example/${path}?token=abc` },
    error: null,
  })),
}));

vi.mock('./SupabaseClient', () => ({
  supabase: { storage: { from: vi.fn(() => supabaseStorageMock) } },
}));

vi.mock('./ImageStorageService', async () => {
  const actual = await vi.importActual('./ImageStorageService');
  return {
    ...actual,
    uploadSetupAppImage: storageMock.uploadSetupAppImage,
    deleteSetupAppImage: storageMock.deleteSetupAppImage,
  };
});

const {
  FLOOR_PLAN_BUCKET,
  DEVICE_PHOTO_BUCKET,
  FLOOR_PLAN_S3_PREFIX,
  DEVICE_PHOTO_S3_PREFIX,
  isS3ImagePath,
  uploadFloorPlanBackground,
  uploadDevicePhoto,
  deleteStorageObject,
  getImageUrl,
  getFloorPlanImageUrl,
  getDevicePhotoImageUrl,
} = await import('./ImageUploadService');

const pngBlob = { type: 'image/png', size: 1024 };

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.uploadSetupAppImage.mockImplementation(
    async (subpath) => `setup_app/${subpath}.png`,
  );
});

describe('uploads', () => {
  it('writes floor-plan backgrounds to setup_app/floor-plans/', async () => {
    const key = await uploadFloorPlanBackground(7, 42, 'lvl-1', pngBlob);
    const [subpath, blob] = storageMock.uploadSetupAppImage.mock.calls[0];
    expect(blob).toBe(pngBlob);
    expect(subpath).toMatch(/^floor-plans\/7\/42\/lvl-1\/bg-\d+$/);
    expect(key.startsWith(FLOOR_PLAN_S3_PREFIX)).toBe(true);
  });

  it('writes device photos to setup_app/device-photos/', async () => {
    const key = await uploadDevicePhoto(7, 42, 'lvl-1', 'dev-9', 2, pngBlob);
    const [subpath] = storageMock.uploadSetupAppImage.mock.calls[0];
    expect(subpath).toMatch(/^device-photos\/7\/42\/lvl-1\/dev-9\/2-\d+$/);
    expect(key.startsWith(DEVICE_PHOTO_S3_PREFIX)).toBe(true);
  });

  it('never uploads to Supabase Storage', async () => {
    await uploadFloorPlanBackground(1, 2, 3, pngBlob);
    await uploadDevicePhoto(1, 2, 3, 4, 0, pngBlob);
    expect(supabaseStorageMock.remove).not.toHaveBeenCalled();
    expect(storageMock.uploadSetupAppImage).toHaveBeenCalledTimes(2);
  });

  it('sanitizes id segments so a stray id cannot escape the prefix', async () => {
    await uploadFloorPlanBackground('../evil', 'a b', '', pngBlob);
    const [subpath] = storageMock.uploadSetupAppImage.mock.calls[0];
    expect(subpath).not.toContain('..');
    expect(subpath).toMatch(/^floor-plans\/evil\/a-b\/unknown\/bg-\d+$/);
  });
});

describe('reads', () => {
  it('resolves an S3 key to the public bucket URL without signing', async () => {
    const url = await getFloorPlanImageUrl(`${FLOOR_PLAN_S3_PREFIX}7/42/lvl-1/bg-1.png`);
    expect(url).toBe(
      'https://s3.us-east-1.amazonaws.com/com.ensight-technologies.public/setup_app/floor-plans/7/42/lvl-1/bg-1.png',
    );
    expect(supabaseStorageMock.createSignedUrl).not.toHaveBeenCalled();
  });

  it('still signs legacy Supabase paths saved before the migration', async () => {
    const url = await getDevicePhotoImageUrl('7/42/lvl-1/dev-9/0-1.png');
    expect(url).toContain('supabase.example');
    expect(supabaseStorageMock.createSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('caches legacy signed URLs so re-renders do not re-sign', async () => {
    await getImageUrl(DEVICE_PHOTO_BUCKET, 'cached/photo.png');
    await getImageUrl(DEVICE_PHOTO_BUCKET, 'cached/photo.png');
    expect(supabaseStorageMock.createSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('returns null for an empty path', async () => {
    expect(await getFloorPlanImageUrl(null)).toBeNull();
  });
});

describe('deletes', () => {
  it('routes an S3 key to the S3 delete', async () => {
    const key = `${DEVICE_PHOTO_S3_PREFIX}7/42/lvl-1/dev-9/0-1.png`;
    await deleteStorageObject(DEVICE_PHOTO_BUCKET, key);
    expect(storageMock.deleteSetupAppImage).toHaveBeenCalledWith(key);
    expect(supabaseStorageMock.remove).not.toHaveBeenCalled();
  });

  it('routes a legacy path to the Supabase bucket delete', async () => {
    await deleteStorageObject(FLOOR_PLAN_BUCKET, '7/42/lvl-1/bg-1.png');
    expect(supabaseStorageMock.remove).toHaveBeenCalledWith(['7/42/lvl-1/bg-1.png']);
    expect(storageMock.deleteSetupAppImage).not.toHaveBeenCalled();
  });

  it('ignores an empty path', async () => {
    await deleteStorageObject(FLOOR_PLAN_BUCKET, null);
    expect(storageMock.deleteSetupAppImage).not.toHaveBeenCalled();
    expect(supabaseStorageMock.remove).not.toHaveBeenCalled();
  });
});

describe('isS3ImagePath', () => {
  it('splits S3 keys from legacy Supabase paths', () => {
    expect(isS3ImagePath(`${FLOOR_PLAN_S3_PREFIX}a.png`)).toBe(true);
    expect(isS3ImagePath('7/42/lvl-1/bg-1.png')).toBe(false);
    expect(isS3ImagePath(null)).toBe(false);
  });
});
