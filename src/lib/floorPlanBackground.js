import { LOGICAL_W } from './canvasConstants';

export const FLOOR_PLAN_ACCEPT = 'image/png,image/jpeg,image/jpg,image/webp,application/pdf,.pdf';

/** Max rendered width for rasterized backgrounds (2x logical canvas). */
export const MAX_FLOOR_PLAN_RASTER_WIDTH = LOGICAL_W * 2;

/**
 * Size budget for one stored background, measured in encoded bytes.
 *
 * Backgrounds now upload to Supabase Storage as a Blob and the row only stores
 * the object path, so the old ~370 KB data-URL/Sheets-cell ceiling no longer
 * applies. ~500 KB keeps floor plans crisp while staying fast to upload/render.
 */
export const MAX_FLOOR_PLAN_BYTES = 500_000;

/** @deprecated Kept only for the legacy data-URL safety net (see compressOversizedBackgrounds). */
export const MAX_FLOOR_PLAN_DATA_URL_CHARS = 500_000;

/** Quality/resolution ladder, tried in order until the result fits the budget. */
const ENCODE_STEPS = Object.freeze([
  { width: MAX_FLOOR_PLAN_RASTER_WIDTH, quality: 0.9 },
  { width: MAX_FLOOR_PLAN_RASTER_WIDTH, quality: 0.75 },
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

/** Storage cost of a legacy inline background, in data-URL characters (0 when unset). */
export function floorPlanDataUrlChars(dataUrl) {
  return typeof dataUrl === 'string' ? dataUrl.length : 0;
}

/** @deprecated Only meaningful for legacy inline data-URL backgrounds carried over by import. */
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

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode floor plan image.'));
    }, type, quality);
  });
}

/** WebP where supported (much smaller, keeps alpha), JPEG otherwise. */
async function encodeLossyBlob(source, width, height, quality) {
  const canvas = drawScaled(source, width, height);
  const webp = await canvasToBlob(canvas, 'image/webp', quality);
  if (webp.type === 'image/webp') return webp;
  // JPEG has no alpha — flatten onto white so a transparent plan isn't blacked out.
  const flattened = drawScaled(source, width, height, { flatten: true });
  return canvasToBlob(flattened, 'image/jpeg', quality);
}

/**
 * Encode an image source down to the per-background byte budget.
 * Lossless PNG is tried first so line-art plans stay crisp when they already
 * fit; otherwise quality, then resolution, steps down until the result fits.
 * @param {CanvasImageSource} source
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @returns {Promise<Blob>}
 */
async function encodeWithinBudget(source, sourceWidth, sourceHeight) {
  const width = Math.max(1, sourceWidth || MAX_FLOOR_PLAN_RASTER_WIDTH);
  const height = Math.max(1, sourceHeight || Math.round(width * 0.75));
  const aspect = height / width;

  let smallest = null;
  for (const [index, step] of ENCODE_STEPS.entries()) {
    const stepWidth = Math.min(width, step.width);
    const stepHeight = stepWidth * aspect;

    if (index === 0) {
      const png = await canvasToBlob(drawScaled(source, stepWidth, stepHeight), 'image/png');
      if (png.size <= MAX_FLOOR_PLAN_BYTES) return png;
      if (!smallest || png.size < smallest.size) smallest = png;
    }

    const encoded = await encodeLossyBlob(source, stepWidth, stepHeight, step.quality);
    if (encoded.size <= MAX_FLOOR_PLAN_BYTES) return encoded;
    if (!smallest || encoded.size < smallest.size) smallest = encoded;
  }

  // Nothing fit (very large or very noisy source) — keep the smallest attempt.
  return smallest;
}

/**
 * @deprecated Legacy safety net for data-URL backgrounds carried over by JSON import.
 * New backgrounds are uploaded as Storage blobs (see loadFloorPlanBackground) and never
 * take this path. Returns the original when it already fits or cannot be improved.
 * @param {string} dataUrl
 * @returns {Promise<string>}
 */
export async function compressFloorPlanDataUrl(dataUrl) {
  if (!isOversizedFloorPlan(dataUrl)) return dataUrl;
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
    reader.onerror = () => reject(new Error('Failed to re-encode floor plan.'));
    reader.readAsDataURL(blob);
  });
  return encoded && encoded.length < dataUrl.length ? encoded : dataUrl;
}

/**
 * @deprecated Recompress legacy inline (data-URL) level backgrounds before a shared save.
 * Only relevant for setups restored from an old JSON export/import; the live Storage-backed
 * upload path never produces oversized inline data, so this is a no-op for normal usage.
 * @param {object[]} sites
 * @param {{ compress?: (dataUrl: string) => Promise<string> }} [options]
 * @returns {Promise<{ sites: object[], compressed: number, savedChars: number }>}
 */
export async function compressOversizedBackgrounds(sites, options = {}) {
  const compress = options.compress || compressFloorPlanDataUrl;
  if (!Array.isArray(sites)) return { sites, compressed: 0, savedChars: 0 };

  const needsWork = sites.some((site) => (site?.levels ?? []).some(
    (level) => isOversizedFloorPlan(level?.bgImage),
  ));
  if (!needsWork) return { sites, compressed: 0, savedChars: 0 };

  let compressed = 0;
  let savedChars = 0;
  const nextSites = [];

  for (const site of sites) {
    const levels = site?.levels;
    if (!Array.isArray(levels) || !levels.some((level) => isOversizedFloorPlan(level?.bgImage))) {
      nextSites.push(site);
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
    nextSites.push({ ...site, levels: nextLevels });
  }

  return { sites: nextSites, compressed, savedChars };
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
    const blob = await encodeWithinBudget(canvas, canvas.width, canvas.height);

    return {
      blob,
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
  const img = await loadImageElement(original);
  const originalBytes = file.size;

  if (originalBytes <= MAX_FLOOR_PLAN_BYTES) {
    // Still re-encode through canvas so the stored format/dimensions are consistent,
    // but this is effectively pass-through quality (first ladder step).
    const blob = await encodeWithinBudget(
      img,
      img.naturalWidth || img.width,
      img.naturalHeight || img.height,
    );
    return { blob, sourceType: 'image', compressed: blob.size < originalBytes };
  }

  const blob = await encodeWithinBudget(
    img,
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
  );
  return {
    blob,
    sourceType: 'image',
    compressed: true,
    originalBytes,
    compressedBytes: blob.size,
  };
}

/**
 * Load a floor plan background from PNG/JPEG/WebP or PDF, encoded as a Blob ready
 * for upload to the `floor-plans` Supabase Storage bucket (see ImageUploadService).
 * PDFs are rasterized to a canvas first so existing canvas/export paths keep working.
 * Oversized sources are downscaled/recompressed to stay within the ~500KB budget.
 * @param {File} file
 * @param {{ pageNumber?: number }} [options]
 * @returns {Promise<{ blob: Blob, sourceType: 'image' | 'pdf', pageNumber?: number, pageCount?: number, compressed?: boolean }>}
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
