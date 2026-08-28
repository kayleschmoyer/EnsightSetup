import { json, readBody } from '../_http.js';
import { requireEnsightSession, UnauthorizedError } from '../_auth.js';
import { loadCustomerFull, updateCustomerInfo, deleteCustomer, WriteBlockedError } from '../_customers-data.js';

export default async function handler(req, res) {
  const { id } = req.query;
  try {
    await requireEnsightSession(req);
    if (req.method === 'GET') {
      const result = await loadCustomerFull(id);
      if (!result) {
        json(res, 404, { error: `Customer ${id} not found.` });
        return;
      }
      json(res, 200, result);
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      json(res, 200, await updateCustomerInfo(id, body));
      return;
    }
    if (req.method === 'DELETE') {
      await deleteCustomer(id);
      json(res, 200, { ok: true });
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
