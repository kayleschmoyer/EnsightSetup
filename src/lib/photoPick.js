/**
 * Device photo helpers for SetupJson (sign photos, camera view images).
 *
 * Same failure mode as floor plans: full-size phone photos are base64-embedded
 * in the shared snapshot and can blow past the Sheets write limit. Compress on
 * ingest and again before save for anything already stored oversized.
 */

import { approxDataUrlBytes } from './floorPlanBackground';

/**
 * Per-photo budget in data-URL characters (~110 KB encoded).
 * Smaller than floor plans — these are reference shots, not map backgrounds.
 */
export const MAX_DEVICE_PHOTO_DATA_URL_CHARS = 150_000;

/** Longest edge after resize. */
export const MAX_DEVICE_PHOTO_EDGE = 1280;

/** Cap sign photos so one monument cannot fill the whole SetupJson payload. */
export const MAX_SIGN_PHOTOS = 10;

/** Reject absurd source files before decoding (bytes). */
export const MAX_DEVICE_PHOTO_SOURCE_BYTES = 20 * 1024 * 1024;

const ENCODE_STEPS = Object.freeze([
  { edge: MAX_DEVICE_PHOTO_EDGE, quality: 0.82 },
  { edge: MAX_DEVICE_PHOTO_EDGE, quality: 0.7 },
  { edge: 960, quality: 0.65 },
  { edge: 720, quality: 0.55 },
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

export function isOversizedDevicePhoto(dataUrl) {
  return devicePhotoDataUrlChars(dataUrl) > MAX_DEVICE_PHOTO_DATA_URL_CHARS;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
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

function encodeLossy(source, width, height, quality) {
  const canvas = drawScaled(source, width, height);
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', quality);
}

function encodeWithinBudget(source, sourceWidth, sourceHeight) {
  const width = Math.max(1, sourceWidth || MAX_DEVICE_PHOTO_EDGE);
  const height = Math.max(1, sourceHeight || Math.round(width * 0.75));
  const longest = Math.max(width, height);
  const aspect = height / width;

  let smallest = null;
  for (const step of ENCODE_STEPS) {
    const scale = Math.min(1, step.edge / longest);
    const stepWidth = Math.max(1, Math.round(width * scale));
    const stepHeight = Math.max(1, Math.round(stepWidth * aspect));
    const encoded = encodeLossy(source, stepWidth, stepHeight, step.quality);
    if (encoded.length <= MAX_DEVICE_PHOTO_DATA_URL_CHARS) return encoded;
    if (!smallest || encoded.length < smallest.length) smallest = encoded;
  }
  return smallest;
}

/**
 * Shrink an already-stored photo that exceeds the budget.
 * @param {string} dataUrl
 * @returns {Promise<string>}
 */
export async function compressDevicePhotoDataUrl(dataUrl) {
  if (!isOversizedDevicePhoto(dataUrl)) return dataUrl;
  const img = await loadImageElement(dataUrl);
  const encoded = encodeWithinBudget(
    img,
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
  );
  return encoded && encoded.length < dataUrl.length ? encoded : dataUrl;
}

/**
 * Compress one image File for SetupJson storage.
 * @returns {Promise<{ dataUrl: string, compressed: boolean, originalBytes?: number, compressedBytes?: number }>}
 */
export async function prepareDevicePhotoFromFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('Please choose an image file.');
  }
  if (file.size > MAX_DEVICE_PHOTO_SOURCE_BYTES) {
    throw new Error('Photo is too large. Please use an image under 20 MB.');
  }

  const original = await readFileAsDataUrl(file);
  if (!isOversizedDevicePhoto(original)) {
    return { dataUrl: original, compressed: false };
  }

  const img = await loadImageElement(original);
  const dataUrl = encodeWithinBudget(
    img,
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
  );
  if (!dataUrl || dataUrl.length >= original.length) {
    return { dataUrl: original, compressed: false };
  }
  return {
    dataUrl,
    compressed: true,
    originalBytes: approxDataUrlBytes(original),
    compressedBytes: approxDataUrlBytes(dataUrl),
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
 * Recompress oversized device photos (viewImage + signImages) before SetupJson save.
 * @param {object[]} garages
 * @param {{ compress?: (dataUrl: string) => Promise<string> }} [options]
 */
export async function compressOversizedDevicePhotos(garages, options = {}) {
  const compress = options.compress || compressDevicePhotoDataUrl;
  if (!Array.isArray(garages)) return { garages, compressed: 0, savedChars: 0 };

  const needsWork = garages.some((garage) => (garage?.levels ?? []).some((level) => (
    (level?.devices ?? []).some((device) => (
      isOversizedDevicePhoto(device?.viewImage)
      || (Array.isArray(device?.signImages) && device.signImages.some(isOversizedDevicePhoto))
    ))
  )));
  if (!needsWork) return { garages, compressed: 0, savedChars: 0 };

  let compressed = 0;
  let savedChars = 0;
  const nextGarages = [];

  for (const garage of garages) {
    const levels = garage?.levels;
    if (!Array.isArray(levels)) {
      nextGarages.push(garage);
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
    nextGarages.push(
      nextLevels.some((level, i) => level !== levels[i])
        ? { ...garage, levels: nextLevels }
        : garage,
    );
  }

  return { garages: nextGarages, compressed, savedChars };
}
