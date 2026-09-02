/**
 * Device photo helpers (sign photos, camera view images).
 *
 * Photos upload as Blobs to the `device-photos` Supabase Storage bucket (see
 * ImageUploadService) — the row only stores the resulting object key, so there's
 * no more Sheets-cell size ceiling to protect. Still compressed to a byte budget
 * so uploads/renders stay fast on a slow connection.
 */

/** Per-photo byte budget. Smaller than floor plans — these are reference shots, not map backgrounds. */
export const MAX_DEVICE_PHOTO_BYTES = 500_000;

/** @deprecated Kept only for the legacy data-URL safety net (see compressOversizedDevicePhotos). */
export const MAX_DEVICE_PHOTO_DATA_URL_CHARS = 150_000;

/** Longest edge after resize. */
export const MAX_DEVICE_PHOTO_EDGE = 1600;

/** Cap sign photos so one monument cannot fill the whole layout with photos. */
export const MAX_SIGN_PHOTOS = 10;

/** Reject absurd source files before decoding (bytes). */
export const MAX_DEVICE_PHOTO_SOURCE_BYTES = 20 * 1024 * 1024;

const ENCODE_STEPS = Object.freeze([
  { edge: MAX_DEVICE_PHOTO_EDGE, quality: 0.85 },
  { edge: MAX_DEVICE_PHOTO_EDGE, quality: 0.72 },
  { edge: 1200, quality: 0.65 },
  { edge: 900, quality: 0.55 },
]);

/**
 * True on phones/tablets where capture="environment" opens the native camera.
 * Touch laptops with a fine pointer stay on upload-only.
 */
export function prefersNativeCameraCapture() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
    if (window.matchMedia('(hover: none)').matches && (navigator.maxTouchPoints || 0) > 0) {
      return true;
    }
  } catch {
    // matchMedia unavailable
  }
  return false;
}

export function devicePhotoDataUrlChars(dataUrl) {
  return typeof dataUrl === 'string' ? dataUrl.length : 0;
}

/** @deprecated Only meaningful for legacy inline data-URL photos carried over by import. */
export function isOversizedDevicePhoto(dataUrl) {
  return devicePhotoDataUrlChars(dataUrl) > MAX_DEVICE_PHOTO_DATA_URL_CHARS;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the image.'));
    img.src = src;
  });
}

function drawScaled(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create canvas for photo resizing.');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode photo.'));
    }, type, quality);
  });
}

async function encodeLossyBlob(source, width, height, quality) {
  const canvas = drawScaled(source, width, height);
  const webp = await canvasToBlob(canvas, 'image/webp', quality);
  if (webp.type === 'image/webp') return webp;
  return canvasToBlob(canvas, 'image/jpeg', quality);
}

async function encodeWithinBudget(source, sourceWidth, sourceHeight) {
  const width = Math.max(1, sourceWidth || MAX_DEVICE_PHOTO_EDGE);
  const height = Math.max(1, sourceHeight || Math.round(width * 0.75));
  const longest = Math.max(width, height);
  const aspect = height / width;

  let smallest = null;
  for (const step of ENCODE_STEPS) {
    const scale = Math.min(1, step.edge / longest);
    const stepWidth = Math.max(1, Math.round(width * scale));
    const stepHeight = Math.max(1, Math.round(stepWidth * aspect));
    const encoded = await encodeLossyBlob(source, stepWidth, stepHeight, step.quality);
    if (encoded.size <= MAX_DEVICE_PHOTO_BYTES) return encoded;
    if (!smallest || encoded.size < smallest.size) smallest = encoded;
  }
  return smallest;
}

/**
 * @deprecated Legacy safety net for data-URL photos carried over by JSON import. New photos
 * are uploaded as blobs to image storage (see prepareDevicePhotoFromFile) and never take
 * this path.
 * @param {string} dataUrl
 * @returns {Promise<string>}
 */
export async function compressDevicePhotoDataUrl(dataUrl) {
  if (!isOversizedDevicePhoto(dataUrl)) return dataUrl;
  const img = await loadImageElement(dataUrl);
  const blob = await encodeWithinBudget(
    img,
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
  );
  if (!blob) return dataUrl;
  const encoded = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to re-encode photo.'));
    reader.readAsDataURL(blob);
  });
  return encoded && encoded.length < dataUrl.length ? encoded : dataUrl;
}

/**
 * Compress one image File for Storage upload.
 * @returns {Promise<{ blob: Blob, compressed: boolean, originalBytes?: number, compressedBytes?: number }>}
 */
export async function prepareDevicePhotoFromFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('Please choose an image file.');
  }
  if (file.size > MAX_DEVICE_PHOTO_SOURCE_BYTES) {
    throw new Error('Photo is too large. Please use an image under 20 MB.');
  }

  const originalBytes = file.size;
  const src = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
  const img = await loadImageElement(src);
  const blob = await encodeWithinBudget(
    img,
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
  );

  if (!blob || blob.size >= originalBytes) {
    return { blob: blob || file, compressed: false };
  }
  return {
    blob,
    compressed: true,
    originalBytes,
    compressedBytes: blob.size,
  };
}

/**
 * Compress multiple image files, optionally capped (e.g. remaining sign slots).
 * @param {File[]|FileList} files
 * @param {{ maxCount?: number }} [options]
 */
export async function prepareDevicePhotosFromFiles(files = [], { maxCount = Infinity } = {}) {
  const list = Array.from(files)
    .filter((f) => f && String(f.type || '').startsWith('image/'))
    .slice(0, Math.max(0, maxCount));
  const results = [];
  for (const file of list) {
    results.push(await prepareDevicePhotoFromFile(file));
  }
  return results;
}

/** @deprecated Prefer prepareDevicePhotosFromFiles — kept for tests/callers that only need raw reads. */
export function readImageFilesAsDataUrls(files = []) {
  const list = Array.from(files).filter((f) => f && String(f.type || '').startsWith('image/'));
  return Promise.all(list.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(file);
  })));
}

/**
 * @deprecated Recompress legacy inline (data-URL) device photos before a shared save. Only
 * relevant for setups restored from an old JSON export/import; the live Storage-backed upload
 * path never produces oversized inline data, so this is a no-op for normal usage.
 * @param {object[]} sites
 * @param {{ compress?: (dataUrl: string) => Promise<string> }} [options]
 */
export async function compressOversizedDevicePhotos(sites, options = {}) {
  const compress = options.compress || compressDevicePhotoDataUrl;
  if (!Array.isArray(sites)) return { sites, compressed: 0, savedChars: 0 };

  const needsWork = sites.some((site) => (site?.levels ?? []).some((level) => (
    (level?.devices ?? []).some((device) => (
      isOversizedDevicePhoto(device?.viewImage)
      || (Array.isArray(device?.signImages) && device.signImages.some(isOversizedDevicePhoto))
    ))
  )));
  if (!needsWork) return { sites, compressed: 0, savedChars: 0 };

  let compressed = 0;
  let savedChars = 0;
  const nextSites = [];

  for (const site of sites) {
    const levels = site?.levels;
    if (!Array.isArray(levels)) {
      nextSites.push(site);
      continue;
    }

    const nextLevels = [];
    for (const level of levels) {
      const devices = level?.devices;
      if (!Array.isArray(devices)) {
        nextLevels.push(level);
        continue;
      }

      let levelChanged = false;
      const nextDevices = [];
      for (const device of devices) {
        let next = device;
        let changed = false;

        if (isOversizedDevicePhoto(device?.viewImage)) {
          try {
            const viewImage = await compress(device.viewImage);
            if (viewImage && viewImage.length < device.viewImage.length) {
              compressed += 1;
              savedChars += device.viewImage.length - viewImage.length;
              next = { ...next, viewImage };
              changed = true;
            }
          } catch {
            // Keep original — never drop a photo on compress failure.
          }
        }

        if (Array.isArray(device?.signImages) && device.signImages.some(isOversizedDevicePhoto)) {
          const signImages = [];
          let signsChanged = false;
          for (const src of device.signImages) {
            if (!isOversizedDevicePhoto(src)) {
              signImages.push(src);
              continue;
            }
            try {
              const shrunk = await compress(src);
              if (shrunk && shrunk.length < src.length) {
                compressed += 1;
                savedChars += src.length - shrunk.length;
                signImages.push(shrunk);
                signsChanged = true;
              } else {
                signImages.push(src);
              }
            } catch {
              signImages.push(src);
            }
          }
          if (signsChanged) {
            next = { ...next, signImages };
            changed = true;
          }
        }

        if (changed) levelChanged = true;
        nextDevices.push(changed ? next : device);
      }

      nextLevels.push(levelChanged ? { ...level, devices: nextDevices } : level);
    }
    nextSites.push(
      nextLevels.some((level, i) => level !== levels[i])
        ? { ...site, levels: nextLevels }
        : site,
    );
  }

  return { sites: nextSites, compressed, savedChars };
}
