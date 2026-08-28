/**
 * Client helper for the Vercel /api/create-clickup-task proxy.
 * Never holds a ClickUp token — that stays server-side.
 */

const DEFAULT_ENDPOINT = '/api/create-clickup-task';
const MAX_SCREENSHOT_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;
const MAX_SCREENSHOT_BYTES = 2.5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function feedbackEndpoint() {
  const configured = String(import.meta.env.VITE_CLICKUP_FEEDBACK_URL || '').trim();
  return configured || DEFAULT_ENDPOINT;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the screenshot file.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the screenshot image.'));
    img.src = dataUrl;
  });
}

/**
 * Compress/normalize a pasted or uploaded image for the feedback API.
 * @param {File|Blob} file
 * @returns {Promise<{ filename: string, contentType: string, dataBase64: string, previewUrl: string }>}
 */
export async function prepareFeedbackScreenshot(file) {
  if (!file) throw new Error('No screenshot selected.');
  const type = String(file.type || '').toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    throw new Error('Screenshots must be PNG, JPEG, WebP, or GIF.');
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error('Screenshot is too large. Please use an image under 12 MB.');
  }

  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, MAX_SCREENSHOT_DIMENSION / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the screenshot.');
  ctx.drawImage(img, 0, 0, width, height);

  const compressedDataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const comma = compressedDataUrl.indexOf(',');
  const dataBase64 = comma >= 0 ? compressedDataUrl.slice(comma + 1) : '';
  if (!dataBase64) throw new Error('Could not encode the screenshot.');

  const approxBytes = Math.ceil((dataBase64.length * 3) / 4);
  if (approxBytes > MAX_SCREENSHOT_BYTES) {
    throw new Error('Screenshot is still too large after compression. Try a smaller crop.');
  }

  const baseName = String(file.name || 'screenshot')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w-]+/g, '_')
    .slice(0, 60) || 'screenshot';

  return {
    filename: `${baseName}.jpg`,
    contentType: 'image/jpeg',
    dataBase64,
    previewUrl: compressedDataUrl,
  };
}

/**
 * @param {{
 *   title: string,
 *   description?: string,
 *   type?: 'bug'|'request'|'question'|'other',
 *   reporter?: string,
 *   context?: string,
 *   screenshot?: { filename: string, contentType: string, dataBase64: string }|null,
 * }} payload
 */
export async function submitClickUpFeedback(payload) {
  const title = String(payload?.title || '').trim();
  if (!title) {
    throw new Error('Please enter a short title.');
  }

  const body = {
    title,
    description: String(payload?.description || '').trim(),
    type: payload?.type || 'other',
    reporter: String(payload?.reporter || '').trim(),
    context: String(payload?.context || '').trim(),
  };

  if (payload?.screenshot?.dataBase64) {
    body.screenshot = {
      filename: String(payload.screenshot.filename || 'screenshot.jpg').slice(0, 120),
      contentType: String(payload.screenshot.contentType || 'image/jpeg').slice(0, 80),
      dataBase64: payload.screenshot.dataBase64,
    };
  }

  const response = await fetch(feedbackEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Could not create ClickUp task (${response.status}).`);
  }
  return data;
}

/** Build a short context blurb from the current app location. */
export function buildFeedbackContext({
  customer = null,
  site = null,
  level = null,
  pathname = '',
} = {}) {
  const lines = [];
  if (customer?.friendlyName || customer?.customerId) {
    lines.push(`Customer: ${customer.friendlyName || customer.customerId}`);
  }
  if (site?.name) lines.push(`Site: ${site.name}`);
  if (level?.name) lines.push(`Level: ${level.name}`);
  const path = pathname || (typeof window !== 'undefined' ? window.location.pathname : '');
  if (path) lines.push(`URL: ${path}`);
  if (typeof window !== 'undefined' && window.location?.href) {
    lines.push(`Full URL: ${window.location.href}`);
  }
  return lines.join('\n');
}
