import { json } from './_http.js';
import { getSessionEmail } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }
  const email = await getSessionEmail(req);
  json(res, 200, { email: email || null });
}
