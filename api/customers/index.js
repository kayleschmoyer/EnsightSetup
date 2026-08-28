import { json, readBody } from '../_http.js';
import { requireEnsightSession, UnauthorizedError } from '../_auth.js';
import { listCustomers, createCustomer, WriteBlockedError } from '../_customers-data.js';

export default async function handler(req, res) {
  try {
    await requireEnsightSession(req);
    if (req.method === 'GET') {
      json(res, 200, { customers: await listCustomers() });
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      json(res, 200, await createCustomer(body));
      return;
    }
    json(res, 405, { error: 'Method not allowed.' });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      json(res, 401, { error: err.message });
      return;
    }
    if (err instanceof WriteBlockedError) {
      json(res, 403, { error: err.message });
      return;
    }
    json(res, 500, { error: err.message || 'Server error.' });
  }
}
