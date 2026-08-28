import { json } from '../../_http.js';
import { requireEnsightSession, UnauthorizedError } from '../../_auth.js';
import { loadCustomerCard } from '../../_customers-data.js';

export default async function handler(req, res) {
  const { id } = req.query;
  try {
    await requireEnsightSession(req);
    if (req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed.' });
      return;
    }
    const card = await loadCustomerCard(id);
    if (!card) {
      json(res, 404, { error: `Customer ${id} not found.` });
      return;
    }
    json(res, 200, card);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      json(res, 401, { error: err.message });
      return;
    }
    json(res, 500, { error: err.message || 'Server error.' });
  }
}
