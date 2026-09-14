/**
 * "Does this need cleaning?" — strips existing markup off an uploaded floor plan
 * so the editor starts from a bare plan instead of one that already has someone
 * else's cameras, signs and callouts drawn on it.
 *
 * The rule this leans on: architectural plans are drawn in black/grey line art,
 * and the device markup layered on top (camera cones, sign flags, highlight
 * blobs, coloured text) is in colour. So "markup" here means *saturated* pixels,
 * and cleaning means painting those back out from the surrounding plan.
 *
 * That assumption is the whole ballgame — markup drawn in plain black on a plain
 * black plan is indistinguishable from the plan itself and is deliberately left
 * alone rather than guessed at. Callers get `removedPixels` back so the UI can
 * say "nothing found" instead of silently doing nothing.
 *
 * Saturation alone isn't enough, though: plenty of real plans colour-code their
 * own content (a zone highlight, a street-name banner, a callout circle), and
 * that's every bit as saturated as a camera icon. A device callout is always a
 * small, localised blob; a colour-coded region of the plan itself is usually
 * large. So markup pixels are grouped into connected regions, and any region
 * bigger than a device icon has any business being is left alone — see
 * `excludeOversizedComponents`.
 *
 * The core works on plain `{ data, width, height }` — the same shape as
 * ImageData, but without needing a canvas — so it runs (and is tested) under
 * plain node. `cleanFloorPlanBlob` is the browser-only wrapper.
 */
import { encodeWithinBudget } from './floorPlanBackground';

/**
 * Chroma (max channel − min channel, 0–255) at which a pixel counts as markup
 * rather than line art. Greys have a chroma near 0; scanned/JPEG plans carry a
 * few points of colour noise, and 40 clears that without eating genuinely pale
 * markup like a light-blue highlight.
 */
export const DEFAULT_SATURATION_THRESHOLD = 40;

/**
 * Pixels of mask growth before inpainting. Anti-aliased icon edges blend markup
 * colour into the background over a pixel or two; without this they survive as
 * a coloured halo outlining exactly what was just removed.
 */
export const DEFAULT_DILATION = 2;

/**
 * Luminance (0–255) below which a pixel is treated as plan line art and shielded
 * from mask growth. Dilation exists to catch pale anti-aliased halos, which are
 * markup colour blended toward the background — never solid dark. Without this,
 * a camera icon sitting against a wall takes a bite out of the wall with it.
 */
export const DEFAULT_LINE_ART_LUMINANCE = 100;

/** Safety valve — a mask that hasn't closed by now is a huge region, not an icon. */
const MAX_INPAINT_PASSES = 64;

/**
 * Fraction of the whole image, above which a connected blob of markup pixels
 * is treated as the plan's own colour-coding rather than a device callout.
 * A camera cone or sign flag is a handful of pixels on any real upload; a
 * colour-coded zone fill or a street-banner background can be a large slice
 * of the whole plan, so 0.5% leaves generous headroom above any real icon
 * while still catching those.
 */
export const DEFAULT_MAX_MARKUP_AREA_RATIO = 0.005;

/**
 * Floor under the ratio above, in raw pixels, so a small or low-resolution
 * upload doesn't shrink the cap below what a real icon needs. A device icon
 * comfortably fits inside an 8x8 block even on a modest scan.
 */
export const DEFAULT_MIN_MARKUP_AREA_PIXELS = 64;

/** Rec. 601 luma — how bright a pixel reads to the eye. */
function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Flag every pixel whose chroma reads as markup rather than plan line art.
 * @param {{ data: Uint8ClampedArray | number[], width: number, height: number }} image
 * @param {{ saturationThreshold?: number }} [options]
 * @returns {Uint8Array} 1 per markup pixel, 0 otherwise, in row-major order
 */
export function buildMarkingMask(image, options = {}) {
  const { saturationThreshold = DEFAULT_SATURATION_THRESHOLD } = options;
  const { data, width, height } = image;
  const mask = new Uint8Array(width * height);

  for (let i = 0; i < mask.length; i += 1) {
    const offset = i * 4;
    const alpha = data[offset + 3];
    // A transparent pixel has no colour to judge — leave it to the plan.
    if (alpha === 0) continue;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma >= saturationThreshold) mask[i] = 1;
  }

  return mask;
}

/**
 * Group a mask's pixels into 4-connected regions.
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {{ labels: Int32Array, sizes: number[] }} `labels[i]` is the
 *   1-based region id at pixel `i` (0 = not in the mask); `sizes[id - 1]` is
 *   that region's pixel count.
 */
export function labelConnectedComponents(mask, width, height) {
  const labels = new Int32Array(mask.length);
  const sizes = [];
  const stack = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;

    const id = sizes.length + 1;
    let size = 0;
    labels[start] = id;
    stack.push(start);

    while (stack.length) {
      const index = stack.pop();
      size += 1;
      const x = index % width;
      const y = (index - x) / width;

      if (x > 0 && mask[index - 1] && !labels[index - 1]) {
        labels[index - 1] = id;
        stack.push(index - 1);
      }
      if (x < width - 1 && mask[index + 1] && !labels[index + 1]) {
        labels[index + 1] = id;
        stack.push(index + 1);
      }
      if (y > 0 && mask[index - width] && !labels[index - width]) {
        labels[index - width] = id;
        stack.push(index - width);
      }
      if (y < height - 1 && mask[index + width] && !labels[index + width]) {
        labels[index + width] = id;
        stack.push(index + width);
      }
    }

    sizes.push(size);
  }

  return { labels, sizes };
}

/**
 * Drop any connected region bigger than `maxComponentPixels` from a mask —
 * the plan's own colour-coding (a zone fill, a banner) rather than a device
 * callout. Leaves the mask untouched if nothing exceeds it.
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} maxComponentPixels
 * @returns {Uint8Array}
 */
export function excludeOversizedComponents(mask, width, height, maxComponentPixels) {
  const { labels, sizes } = labelConnectedComponents(mask, width, height);
  if (!sizes.some((size) => size > maxComponentPixels)) return mask;

  const filtered = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    const id = labels[i];
    if (id && sizes[id - 1] <= maxComponentPixels) filtered[i] = 1;
  }
  return filtered;
}

/**
 * Grow a mask by `radius` pixels. Separable (horizontal then vertical) so the
 * cost stays O(pixels × radius) instead of O(pixels × radius²).
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Uint8Array} a new, grown mask
 */
export function dilateMask(mask, width, height, radius) {
  if (!radius || radius < 1) return mask;

  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!mask[row + x]) continue;
      const from = Math.max(0, x - radius);
      const to = Math.min(width - 1, x + radius);
      for (let nx = from; nx <= to; nx += 1) horizontal[row + nx] = 1;
    }
  }

  const grown = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!horizontal[row + x]) continue;
      const from = Math.max(0, y - radius);
      const to = Math.min(height - 1, y + radius);
      for (let ny = from; ny <= to; ny += 1) grown[ny * width + x] = 1;
    }
  }

  return grown;
}

/** Mean colour of everything the mask left alone — what unreachable holes fall back to. */
function averageUnmaskedColor(data, mask) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) continue;
    const offset = i * 4;
    r += data[offset];
    g += data[offset + 1];
    b += data[offset + 2];
    count += 1;
  }
  // An all-markup image has no plan left to sample; white is the safe plan colour.
  if (!count) return [255, 255, 255];
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

/**
 * Paint masked pixels back out from their surroundings.
 *
 * Works inward from the mask edge: each pass fills only the masked pixels that
 * touch already-known colour, averaging those neighbours, so a removed icon
 * closes over with the plan around it rather than a flat patch. Reads come from
 * the previous pass's snapshot, so fill order within a pass can't skew a result.
 *
 * @param {Uint8ClampedArray | number[]} data RGBA, mutated in place
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 */
export function inpaintMasked(data, mask, width, height) {
  let pending = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) pending.push(i);
  }
  if (!pending.length) return;

  const unresolved = Uint8Array.from(mask);

  for (let pass = 0; pass < MAX_INPAINT_PASSES && pending.length; pass += 1) {
    // Snapshot the frontier so every pixel in this pass reads the same state.
    const known = Uint8Array.from(unresolved);
    const snapshot = Uint8ClampedArray.from(data);
    const stillPending = [];
    let filled = 0;

    for (const index of pending) {
      const x = index % width;
      const y = (index - x) / width;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (dx === 0 && dy === 0) continue;
          const neighbour = ny * width + nx;
          if (known[neighbour]) continue;
          const offset = neighbour * 4;
          r += snapshot[offset];
          g += snapshot[offset + 1];
          b += snapshot[offset + 2];
          a += snapshot[offset + 3];
          count += 1;
        }
      }

      if (!count) {
        stillPending.push(index);
        continue;
      }

      const offset = index * 4;
      data[offset] = Math.round(r / count);
      data[offset + 1] = Math.round(g / count);
      data[offset + 2] = Math.round(b / count);
      data[offset + 3] = Math.round(a / count);
      unresolved[index] = 0;
      filled += 1;
    }

    pending = stillPending;
    // No pixel touched known colour this pass and none ever will — stop early.
    if (!filled) break;
  }

  if (!pending.length) return;

  const [r, g, b] = averageUnmaskedColor(data, mask);
  for (const index of pending) {
    const offset = index * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  }
}

/**
 * Remove coloured markup from one image, in place.
 * @param {{ data: Uint8ClampedArray | number[], width: number, height: number }} image
 * @param {{ saturationThreshold?: number, dilation?: number, maxMarkupAreaRatio?: number }} [options]
 * @returns {{ removedPixels: number, totalPixels: number, removedRatio: number }}
 */
export function cleanImageData(image, options = {}) {
  const {
    dilation = DEFAULT_DILATION,
    lineArtLuminance = DEFAULT_LINE_ART_LUMINANCE,
    maxMarkupAreaRatio = DEFAULT_MAX_MARKUP_AREA_RATIO,
  } = options;
  const { data, width, height } = image;
  const totalPixels = width * height;

  const maxComponentPixels = Math.max(
    DEFAULT_MIN_MARKUP_AREA_PIXELS,
    Math.round(totalPixels * maxMarkupAreaRatio),
  );
  const detected = excludeOversizedComponents(
    buildMarkingMask(image, options),
    width,
    height,
    maxComponentPixels,
  );
  let removedPixels = 0;
  for (let i = 0; i < detected.length; i += 1) removedPixels += detected[i];

  // Nothing coloured on the plan — leave the pixels untouched so an already
  // clean upload round-trips byte-for-byte through the "yes, clean it" path.
  if (!removedPixels) return { removedPixels: 0, totalPixels, removedRatio: 0 };

  const mask = dilateMask(detected, width, height, dilation);
  // Growth may have reached into walls and dimension lines the plan needs.
  // Pixels the chroma test actually flagged stay flagged; only the ones
  // dilation added are handed back if they read as line art.
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || detected[i]) continue;
    const offset = i * 4;
    if (luminance(data[offset], data[offset + 1], data[offset + 2]) < lineArtLuminance) {
      mask[i] = 0;
    }
  }

  inpaintMasked(data, mask, width, height);

  return {
    removedPixels,
    totalPixels,
    removedRatio: totalPixels ? removedPixels / totalPixels : 0,
  };
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode the floor plan image for cleaning.'));
    };
    img.src = url;
  });
}

/**
 * Browser entry point: clean an encoded floor-plan Blob and re-encode it within
 * the same size budget as a normal upload.
 *
 * Returns the original Blob untouched when there was no markup to remove, so a
 * "yes please clean it" on an already-bare plan costs nothing and doesn't
 * degrade the image through a pointless re-encode.
 *
 * @param {Blob} blob
 * @param {{ saturationThreshold?: number, dilation?: number, maxMarkupAreaRatio?: number }} [options]
 * @returns {Promise<{ blob: Blob, removedPixels: number, removedRatio: number, cleaned: boolean }>}
 */
export async function cleanFloorPlanBlob(blob, options = {}) {
  const img = await loadImageFromBlob(blob);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create canvas for floor plan cleaning.');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { removedPixels, removedRatio } = cleanImageData(imageData, options);

  if (!removedPixels) {
    return { blob, removedPixels: 0, removedRatio: 0, cleaned: false };
  }

  ctx.putImageData(imageData, 0, 0);
  const encoded = await encodeWithinBudget(canvas, canvas.width, canvas.height);
  return {
    blob: encoded || blob,
    removedPixels,
    removedRatio,
    cleaned: Boolean(encoded),
  };
}
