/**
 * Server-side session handling — replaces Supabase Auth's role. Issues and
 * verifies the app's own signed session JWT (an httpOnly cookie, not
 * localStorage, so it's not readable/stealable via XSS), and is the one
 * place that enforces the org-domain gate for data access, replacing every
 * per-table Postgres RLS policy the old Supabase schema had (those were all
 * the same flat "is_ensight_staff()" check — see sql/schema.sql's header).
 */
/* global process */
import { SignJWT, jwtVerify } from 'jose';
import { isEnsightEmail, ALLOWED_EMAIL_DOMAIN } from '../src/lib/authDomain.js';

const SESSION_COOKIE = 'ensight_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function getSecretKey() {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) throw new Error('SESSION_JWT_SECRET is not configured on the server.');
  return new TextEncoder().encode(secret);
}

/** vercel dev serves http://localhost — a Secure cookie would be silently dropped there. */
function isLocalRequest(req) {
  return String(req.headers.host || '').startsWith('localhost');
}

export async function issueSessionToken(email) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export function sessionCookieHeader(req, token, { clear = false } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=${clear ? '' : token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    clear ? 'Max-Age=0' : `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (!isLocalRequest(req)) attrs.splice(1, 0, 'Secure');
  return attrs.join('; ');
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export async function getSessionEmail(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

export class UnauthorizedError extends Error {
  constructor(message) {
    super(message || `Access restricted to @${ALLOWED_EMAIL_DOMAIN} accounts.`);
    this.name = 'UnauthorizedError';
    this.statusCode = 401;
  }
}

/** Throws UnauthorizedError unless the request carries a valid, org-domain session. */
export async function requireEnsightSession(req) {
  const email = await getSessionEmail(req);
  if (!email || !isEnsightEmail(email)) throw new UnauthorizedError();
  return { email };
}
