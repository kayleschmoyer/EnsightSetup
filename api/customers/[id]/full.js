import { json, readBody } from '../../_http.js';
import { requireEnsightSession, UnauthorizedError } from '../../_auth.js';
import { saveCustomerFull, WriteBlockedError } from '../../_customers-data.js';

export default async function handler(req, res) {
  const { id } = req.query;
  try {
    await requireEnsightSession(req);
    if (req.method !== 'PUT') {
      json(res, 405, { error: 'Method not allowed.' });
      return;
    }
    const body = await readBody(req);
    const result = await saveCustomerFull(id, body.customer, body.expectedUpdatedAt ?? null);
    json(res, 200, result);
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
