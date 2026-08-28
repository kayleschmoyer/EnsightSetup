/**
 * Vercel serverless function — Phase 0 walking skeleton. Proves the MySQL
 * connection works end to end. No auth yet (that lands in a later phase) —
 * do not build real data endpoints on this pattern until auth middleware
 * exists.
 */
import { getPool } from './_db.js';

export default async function handler(req, res) {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: rows?.[0]?.ok === 1 }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err.message || 'Database connection failed.' }));
  }
}
