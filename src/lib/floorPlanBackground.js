import { LOGICAL_W } from './canvasConstants';

export const FLOOR_PLAN_ACCEPT = 'image/png,image/jpeg,image/jpg,image/webp,application/pdf,.pdf';

/** Max rendered width for rasterized backgrounds (2x logical canvas). */
export const MAX_FLOOR_PLAN_RASTER_WIDTH = LOGICAL_W * 2;

/**
 * Size budget for one stored background, measured in data-URL characters.
 *
 * Backgrounds are embedded in the SetupJson payload that gets written to Google
 * Sheets, and base64 inflates a file by ~33%: a 5 MB photo lands as ~6.8M
 * characters. A couple of those push the write past the Sheets API request
 * limit and every save for that customer starts failing, so cap each
 * background instead. 500k characters ≈ 370 KB encoded, which is plenty at
 * 2400px wide.
 */
export const MAX_FLOOR_PLAN_DATA_URL_CHARS = 500_000;

/** Quality/resolution ladder, tried in order until the result fits the budget. */
const ENCODE_STEPS = Object.freeze([
  { width: MAX_FLOOR_PLAN_RASTER_WIDTH, quality: 0.85 },
  { width: MAX_FLOOR_PLAN_RASTER_WIDTH, quality: 0.7 },
  { width: 1800, quality: 0.7 },
  { width: LOGICAL_W, quality: 0.6 },
]);

export function isPdfFloorPlanFile(file) {
  if (!file) return false;
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return type === 'application/pdf' || name.endsWith('.pdf');
}

export function isImageFloorPlanFile(file) {
  if (!file) return false;
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  const name = (file.name || '').toLowerCase();
  return /\.(png|jpe?g|webp)$/i.test(name);
}

/** Storage cost of a background, in data-URL characters (0 when unset). */
export function floorPlanDataUrlChars(dataUrl) {
  return typeof dataUrl === 'string' ? dataUrl.length : 0;
}

export function isOversizedFloorPlan(dataUrl) {
  return floorPlanDataUrlChars(dataUrl) > MAX_FLOOR_PLAN_DATA_URL_CHARS;
}

/** Approximate decoded size of a data URL, for human-readable messages. */
export function approxDataUrlBytes(dataUrl) {
  const chars = floorPlanDataUrlChars(dataUrl);
  if (!chars) return 0;
  const commaIndex = dataUrl.indexOf(',');
  const base64Length = commaIndex >= 0 ? chars - commaIndex - 1 : chars;
  return Math.max(0, Math.floor((base64Length * 3) / 4));
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the floor plan image.'));
    img.src = src;
  });
}

function drawScaled(source, width, height, { flatten = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create canvas for floor plan resizing.');
  }
  ctx.imageSmoothingQuality = 'high';
  if (flatten) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** WebP where supported (much smaller, keeps alpha), JPEG otherwise. */
function encodeLossy(source, width, height, quality) {
  const webp = drawScaled(source, width, height).toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  // JPEG has no alpha — flatten onto white so a transparent plan isn't blacked out.
  return drawScaled(source, width, height, { flatten: true }).toDataURL('image/jpeg', quality);
}

/**
 * Encode an image source down to the per-background budget.
 * Lossless PNG is tried first so line-art plans stay crisp when they already
 * fit; otherwise quality, then resolution, steps down until the result fits.
 * @param {CanvasImageSource} source
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @returns {string} data URL
 */
function encodeWithinBudget(source, sourceWidth, sourceHeight) {
  const width = Math.max(1, sourceWidth || MAX_FLOOR_PLAN_RASTER_WIDTH);
  const height = Math.max(1, sourceHeight || Math.round(width * 0.75));
  const aspect = height / width;

  let smallest = null;
  for (const [index, step] of ENCODE_STEPS.entries()) {
    const stepWidth = Math.min(width, step.width);
    const stepHeight = stepWidth * aspect;

    if (index === 0) {
      const png = drawScaled(source, stepWidth, stepHeight).toDataURL('image/png');
      if (png.length <= MAX_FLOOR_PLAN_DATA_URL_CHARS) return png;
    }

    const encoded = encodeLossy(source, stepWidth, stepHeight, step.quality);
    if (encoded.length <= MAX_FLOOR_PLAN_DATA_URL_CHARS) return encoded;
    if (!smallest || encoded.length < smallest.length) smallest = encoded;
  }

  // Nothing fit (very large or very noisy source) — keep the smallest attempt.
  return smallest;
}

/**
 * Shrink an already-stored background that exceeds the budget.
 * Returns the original when it already fits or cannot be improved.
 * @param {string} dataUrl
 * @returns {Promise<string>}
 */
export async function compressFloorPlanDataUrl(dataUrl) {
  if (!isOversizedFloorPlan(dataUrl)) return dataUrl;
  const img = await loadImageElement(dataUrl);
  const encoded = encodeWithinBudget(
    img,
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
  );
  return encoded && encoded.length < dataUrl.length ? encoded : dataUrl;
}

/**
 * Recompress every level background that exceeds the budget.
 * Used before a shared save so setups captured by older builds (full-size
 * photos) can still be written to the sheet.
 * @param {object[]} garages
 * @param {{ compress?: (dataUrl: string) => Promise<string> }} [options]
 * @returns {Promise<{ garages: object[], compressed: number, savedChars: number }>}
 */
export async function compressOversizedBackgrounds(garages, options = {}) {
  const compress = options.compress || compressFloorPlanDataUrl;
  if (!Array.isArray(garages)) return { garages, compressed: 0, savedChars: 0 };

  const needsWork = garages.some((garage) => (garage?.levels ?? []).some(
    (level) => isOversizedFloorPlan(level?.bgImage),
  ));
  if (!needsWork) return { garages, compressed: 0, savedChars: 0 };

  let compressed = 0;
  let savedChars = 0;
  const nextGarages = [];

  for (const garage of garages) {
    const levels = garage?.levels;
    if (!Array.isArray(levels) || !levels.some((level) => isOversizedFloorPlan(level?.bgImage))) {
      nextGarages.push(garage);
      continue;
    }

    const nextLevels = [];
    for (const level of levels) {
      if (!isOversizedFloorPlan(level?.bgImage)) {
        nextLevels.push(level);
        continue;
      }
      try {
        const bgImage = await compress(level.bgImage);
        if (bgImage && bgImage.length < level.bgImage.length) {
          compressed += 1;
          savedChars += level.bgImage.length - bgImage.length;
          nextLevels.push({ ...level, bgImage });
          continue;
        }
      } catch {
        // Keep the original background — a failed shrink must not drop the plan.
      }
      nextLevels.push(level);
    }
    nextGarages.push({ ...garage, levels: nextLevels });
  }

  return { garages: nextGarages, compressed, savedChars };
}

let pdfjsReady = null;

async function getPdfJs() {
  if (!pdfjsReady) {
    pdfjsReady = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return pdfjsReady;
}

async function rasterizePdfPage(file, pageNumber = 1) {
  const pdfjs = await getPdfJs();
  const data = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjs.getDocument({ data });

  try {
    const pdf = await loadingTask.promise;

    const pageCount = pdf.numPages;
    const pageNum = Math.min(Math.max(1, pageNumber), pageCount);
    const page = await pdf.getPage(pageNum);

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = MAX_FLOOR_PLAN_RASTER_WIDTH / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not create canvas for PDF rendering.');
    }

    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const dataUrl = encodeWithinBudget(canvas, canvas.width, canvas.height);

    return {
      dataUrl,
      sourceType: 'pdf',
      pageNumber: pageNum,
      pageCount,
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function loadImageFloorPlan(file) {
  const original = await readImageAsDataUrl(file);
  if (!isOversizedFloorPlan(original)) {
    return { dataUrl: original, sourceType: 'image', compressed: false };
  }

  const img = await loadImageElement(original);
  const dataUrl = encodeWithinBudget(
    img,
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
  );
  if (!dataUrl || dataUrl.length >= original.length) {
    return { dataUrl: original, sourceType: 'image', compressed: false };
  }
  return {
    dataUrl,
    sourceType: 'image',
    compressed: true,
    originalBytes: approxDataUrlBytes(original),
    compressedBytes: approxDataUrlBytes(dataUrl),
  };
}

/**
 * Load a floor plan background from PNG/JPEG/WebP or PDF.
 * PDFs are rasterized to data URLs so existing canvas/export paths keep working.
 * Oversized sources are downscaled/recompressed to stay within the per-background
 * budget — full-size photos otherwise break the shared Google Sheets save.
 * @param {File} file
 * @param {{ pageNumber?: number }} [options]
 * @returns {Promise<{ dataUrl: string, sourceType: 'image' | 'pdf', pageNumber?: number, pageCount?: number, compressed?: boolean }>}
 */
export async function loadFloorPlanBackground(file, { pageNumber = 1 } = {}) {
  if (!file) {
    throw new Error('No file selected.');
  }

  if (isPdfFloorPlanFile(file)) {
    return rasterizePdfPage(file, pageNumber);
  }

  if (isImageFloorPlanFile(file)) {
    return loadImageFloorPlan(file);
  }

  throw new Error('Unsupported file type. Upload a PNG, JPEG, WebP, or PDF floor plan.');
}
