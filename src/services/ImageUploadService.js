import { supabase } from './SupabaseClient';
import { guardedWrite } from './WriteGuard';

export const FLOOR_PLAN_BUCKET = 'floor-plans';
export const DEVICE_PHOTO_BUCKET = 'device-photos';

const SIGNED_URL_TTL_SECONDS = 3600;
// Refresh a bit before actual expiry so a render never races an expired URL.
const SIGNED_URL_CACHE_MARGIN_MS = 60_000;

const signedUrlCache = new Map(); // path -> { url, expiresAt }

function extensionForBlob(blob) {
  const type = blob?.type || '';
  if (type.includes('webp')) return 'webp';
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  return 'bin';
}

/**
 * Upload a compressed floor-plan Blob (see loadFloorPlanBackground) to the
 * `floor-plans` bucket and return the stored object path, ready to save on
 * levels.bg_image_path.
 */
export async function uploadFloorPlanBackground(customerId, siteId, levelId, blob) {
  const path = `${customerId}/${siteId}/${levelId}/bg-${Date.now()}.${extensionForBlob(blob)}`;
  return guardedWrite(
    () => ({
      title: `Upload floor-plan background to storage bucket "${FLOOR_PLAN_BUCKET}"`,
      tables: [`storage.objects (${FLOOR_PLAN_BUCKET})`],
      changes: [{
        table: FLOOR_PLAN_BUCKET, identifier: path, before: null, after: `${blob.type || 'unknown type'}, ${blob.size} bytes`,
      }],
    }),
    async () => {
      const { error } = await supabase.storage
        .from(FLOOR_PLAN_BUCKET)
        .upload(path, blob, { contentType: blob.type, upsert: false });
      if (error) throw error;
      return path;
    },
  );
}

/**
 * Upload a compressed device/sign photo Blob (see prepareDevicePhotoFromFile) to
 * the `device-photos` bucket and return the stored object path.
 */
export async function uploadDevicePhoto(customerId, siteId, levelId, deviceId, index, blob) {
  const path = `${customerId}/${siteId}/${levelId}/${deviceId}/${index}-${Date.now()}.${extensionForBlob(blob)}`;
  return guardedWrite(
    () => ({
      title: `Upload device photo to storage bucket "${DEVICE_PHOTO_BUCKET}"`,
      tables: [`storage.objects (${DEVICE_PHOTO_BUCKET})`],
      changes: [{
        table: DEVICE_PHOTO_BUCKET, identifier: path, before: null, after: `${blob.type || 'unknown type'}, ${blob.size} bytes`,
      }],
    }),
    async () => {
      const { error } = await supabase.storage
        .from(DEVICE_PHOTO_BUCKET)
        .upload(path, blob, { contentType: blob.type, upsert: false });
      if (error) throw error;
      return path;
    },
  );
}

export async function deleteStorageObject(bucket, path) {
  if (!path) return;
  return guardedWrite(
    () => ({
      title: `Delete storage object from bucket "${bucket}"`,
      tables: [`storage.objects (${bucket})`],
      changes: [{ table: bucket, identifier: path, before: path, after: null }],
    }),
    async () => {
      await supabase.storage.from(bucket).remove([path]);
      signedUrlCache.delete(path);
    },
  );
}

/**
 * Resolve a Storage object path to a short-lived signed URL for rendering,
 * cached client-side so a canvas re-render doesn't re-request one every frame.
 */
export async function getSignedUrl(bucket, path) {
  if (!path) return null;
  const cached = signedUrlCache.get(path);
  if (cached && cached.expiresAt - SIGNED_URL_CACHE_MARGIN_MS > Date.now()) {
    return cached.url;
  }
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  signedUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
  });
  return data.signedUrl;
}

export const getFloorPlanSignedUrl = (path) => getSignedUrl(FLOOR_PLAN_BUCKET, path);
export const getDevicePhotoSignedUrl = (path) => getSignedUrl(DEVICE_PHOTO_BUCKET, path);
