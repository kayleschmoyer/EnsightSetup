/**
 * Vercel serverless function — verifies a Google Identity Services ID token
 * server-side (never trust a client-asserted email) and, only for
 * @ensight-technologies.com accounts, issues this app's own session cookie.
 * The `hd` hint on the client's GSI prompt is a UX nicety only (Google
 * doesn't hard-enforce it) — this check is the real gate, same role
 * is_ensight_staff() played in the old Postgres RLS policies.
 */
/* global process */
import { OAuth2Client } from 'google-auth-library';
import { json, readBody } from './_http.js';
import { issueSessionToken, sessionCookieHeader } from './_auth.js';
import { isEnsightEmail, ALLOWED_EMAIL_DOMAIN } from '../src/lib/authDomain.js';

const client = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }

  try {
    const { idToken } = await readBody(req);
    if (!idToken) {
      json(res, 400, { error: 'Missing idToken.' });
      return;
    }

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.VITE_GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload?.email || '';

    if (!payload?.email_verified || !isEnsightEmail(email)) {
      json(res, 403, {
        error: `Access restricted to @${ALLOWED_EMAIL_DOMAIN} accounts. You signed in as ${email || 'an unknown account'}.`,
      });
      return;
    }

    const token = await issueSessionToken(email);
    res.setHeader('Set-Cookie', sessionCookieHeader(req, token));
    json(res, 200, { email });
  } catch (err) {
    json(res, 401, { error: err.message || 'Sign-in failed.' });
  }
}
