/**
 * Vercel serverless function — creates a ClickUp task in Personal List.
 * Secrets stay server-side (CLICKUP_API_TOKEN, CLICKUP_LIST_ID, etc.).
 */
/* global Buffer, process */

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 8000;
const MAX_CONTEXT = 2000;
const MAX_BODY_BYTES = 3.5 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 2.5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['bug', 'request', 'question', 'other']);
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://localhost:5173',
  'https://setup.ensightful.io',
  'https://garage-level-webapp.vercel.app',
];

function allowedOrigins() {
  const fromEnv = String(process.env.CLICKUP_FEEDBACK_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ALLOWED_ORIGINS;
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeText(value, max) {
  return String(value ?? '')
    // Strip ASCII control chars except tab/newline/carriage-return.
    // eslint-disable-next-line no-control-regex -- intentional input sanitization
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

function parseScreenshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const contentType = String(raw.contentType || '').toLowerCase().trim();
  const filename = sanitizeText(raw.filename || 'screenshot.jpg', 120) || 'screenshot.jpg';
  const dataBase64 = String(raw.dataBase64 || '').replace(/\s+/g, '');
  if (!dataBase64) return null;
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error('Screenshot must be PNG, JPEG, WebP, or GIF.');
  }
  let buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    throw new Error('Screenshot data is invalid.');
  }
  if (!buffer.length) throw new Error('Screenshot data is empty.');
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    throw new Error('Screenshot is too large.');
  }
  return { filename, contentType, buffer };
}

async function resolveAssigneeId(token, email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;

  const response = await fetch(`${CLICKUP_API}/team`, {
    headers: { Authorization: token },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Could not load ClickUp workspace members (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  const teams = Array.isArray(data?.teams) ? data.teams : [];
  for (const team of teams) {
    for (const member of team.members || []) {
      const user = member.user || member;
      if (String(user?.email || '').trim().toLowerCase() === target) {
        return user.id;
      }
    }
  }
  return null;
}

async function uploadAttachment(token, taskId, screenshot) {
  const form = new FormData();
  form.append(
    'attachment',
    new Blob([screenshot.buffer], { type: screenshot.contentType }),
    screenshot.filename,
  );
  const response = await fetch(
    `${CLICKUP_API}/task/${encodeURIComponent(taskId)}/attachment`,
    {
      method: 'POST',
      headers: { Authorization: token },
      body: form,
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Task created, but screenshot upload failed (${response.status}): ${text.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const token = process.env.CLICKUP_API_TOKEN;
  const listId = process.env.CLICKUP_LIST_ID;
  const assigneeEmail = process.env.CLICKUP_ASSIGNEE_EMAIL || 'kayle.schmoyer@ensight-technologies.com';
  const assigneeIdEnv = process.env.CLICKUP_ASSIGNEE_ID;

  if (!token || !listId) {
    json(res, 503, {
      error: 'ClickUp feedback is not configured on the server yet.',
    });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    json(res, 400, { error: err.message || 'Invalid request.' });
    return;
  }

  const title = sanitizeText(body.title, MAX_TITLE);
  const description = sanitizeText(body.description, MAX_DESCRIPTION);
  const type = sanitizeText(body.type || 'other', 32).toLowerCase();
  const reporter = sanitizeText(body.reporter, 200);
  const context = sanitizeText(body.context, MAX_CONTEXT);

  let screenshot = null;
  try {
    screenshot = parseScreenshot(body.screenshot);
  } catch (err) {
    json(res, 400, { error: err.message || 'Invalid screenshot.' });
    return;
  }

  if (!title) {
    json(res, 400, { error: 'Title is required.' });
    return;
  }
  if (!ALLOWED_TYPES.has(type)) {
    json(res, 400, { error: 'Invalid issue type.' });
    return;
  }

  try {
    let assigneeId = assigneeIdEnv ? Number(assigneeIdEnv) : null;
    if (!Number.isFinite(assigneeId) || assigneeId <= 0) {
      assigneeId = await resolveAssigneeId(token, assigneeEmail);
    }

    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    const markdown = [
      `**Type:** ${typeLabel}`,
      reporter ? `**Reported by:** ${reporter}` : null,
      screenshot ? '**Screenshot:** attached' : null,
      '',
      description || '_No description provided._',
      context ? `\n---\n**App context**\n${context}` : null,
      `\n_Submitted from Garage Editor_`,
    ].filter((line) => line != null).join('\n');

    const payload = {
      name: `[Garage Editor] ${title}`,
      markdown_description: markdown,
      tags: ['garage-editor', type],
      notify_all: false,
    };
    if (assigneeId) {
      payload.assignees = [assigneeId];
    }

    const response = await fetch(`${CLICKUP_API}/list/${encodeURIComponent(listId)}/task`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.err || data?.error || `ClickUp API error (${response.status})`;
      json(res, response.status >= 400 && response.status < 600 ? response.status : 502, {
        error: String(message),
      });
      return;
    }

    const taskId = data.id || null;
    let attachmentError = null;
    if (taskId && screenshot) {
      try {
        await uploadAttachment(token, taskId, screenshot);
      } catch (err) {
        attachmentError = err.message || 'Screenshot upload failed.';
      }
    }

    json(res, 200, {
      ok: true,
      taskId,
      taskUrl: data.url || null,
      ...(attachmentError ? { warning: attachmentError } : {}),
    });
  } catch (err) {
    json(res, 502, {
      error: err.message || 'Failed to create ClickUp task.',
    });
  }
}
