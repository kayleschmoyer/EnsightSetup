import { json } from './_http.js';
import { sessionCookieHeader } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }
  res.setHeader('Set-Cookie', sessionCookieHeader(req, '', { clear: true }));
  json(res, 200, { ok: true });
}
