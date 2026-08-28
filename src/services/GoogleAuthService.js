/**
 * Replaces SupabaseAuthService.js — signs in directly with Google Identity
 * Services (GSI) instead of going through Supabase Auth's OAuth wrapper.
 * The `hd` hint on the GSI config is a UX nicety only (Google doesn't hard-
 * enforce it), so the post-login domain check here and the server-side check
 * in api/auth-google.js (the real gate, replacing Postgres RLS) both matter.
 *
 * Uses Google's own rendered button (renderSignInButton), not a custom
 * button that calls prompt()/One Tap programmatically — prompt() depends on
 * Chrome's FedCM being enabled for this site, which the browser silently
 * disables after a user dismisses it once, with no reliable way to force it
 * back on. renderButton's click-triggered flow doesn't have that failure mode.
 *
 * No server push exists for sign-in/out (unlike Supabase Auth's websocket),
 * so onAuthStateChange is a plain local pub-sub fed by the GSI callback and
 * signOut() — there's nothing else that could change the session out from
 * under this tab.
 */
import { isEnsightEmail, ALLOWED_EMAIL_DOMAIN } from '../lib/authDomain';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

let gsiLoadPromise = null;
function loadGsiScript() {
  if (gsiLoadPromise) return gsiLoadPromise;
  gsiLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services.'));
    document.head.appendChild(script);
  });
  return gsiLoadPromise;
}

const authListeners = new Set();
const errorListeners = new Set();
function notify(session) {
  for (const callback of authListeners) callback(session);
}
function notifyError(err) {
  for (const callback of errorListeners) callback(err);
}

async function handleCredentialResponse(response) {
  try {
    const res = await fetch('/api/auth-google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: response.credential }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || 'Sign-in failed.');
    notify({ email: body.email });
  } catch (err) {
    notifyError(err);
  }
}

let gsiReadyPromise = null;
function ensureGsiReady() {
  if (!gsiReadyPromise) {
    gsiReadyPromise = loadGsiScript().then(() => {
      window.google.accounts.id.initialize({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        hd: ALLOWED_EMAIL_DOMAIN,
      });
    });
  }
  return gsiReadyPromise;
}

/**
 * Mounts Google's own "Sign in with Google" button into `container`. Safe to
 * call more than once (e.g. on re-render) — Google's button replaces its own
 * previous contents in the same container.
 * @param {HTMLElement} container
 * @param {object} [options] - overrides for google.accounts.id.renderButton's options
 */
export async function renderSignInButton(container, options = {}) {
  await ensureGsiReady();
  window.google.accounts.id.renderButton(container, {
    type: 'standard',
    theme: 'outline',
    size: 'medium',
    text: 'signin_with',
    shape: 'rectangular',
    ...options,
  });
}

/**
 * Fires when a sign-in attempt (via the rendered button) fails — wrong
 * domain, network error, etc. Successful sign-ins go through
 * onAuthStateChange instead.
 * @param {(err: Error) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onSignInError(callback) {
  errorListeners.add(callback);
  return () => errorListeners.delete(callback);
}

export async function signOut() {
  try {
    window.google?.accounts?.id?.disableAutoSelect();
  } catch {
    // GSI not loaded yet — nothing to disable.
  }
  await fetch('/api/auth-logout', { method: 'POST' }).catch(() => {});
  notify(null);
}

export async function getSession() {
  const res = await fetch('/api/auth-session');
  if (!res.ok) return null;
  const { email } = await res.json().catch(() => ({ email: null }));
  return email ? { email } : null;
}

export async function isSignedIn() {
  return Boolean(await getSession());
}

export { isEnsightEmail };

/**
 * Belt-and-suspenders check for the current session's email domain, matching
 * the rejection message shape the app already shows.
 * @returns {Promise<{ email: string }>}
 */
export async function requireEnsightSession() {
  const session = await getSession();
  if (!session || !isEnsightEmail(session.email)) {
    if (session) await signOut();
    throw new Error(`Access restricted to @${ALLOWED_EMAIL_DOMAIN} accounts. You signed in as ${session?.email || 'an unknown account'}.`);
  }
  return session;
}

/**
 * Subscribe to auth state changes (sign-in, sign-out).
 * @param {(session: { email: string } | null) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onAuthStateChange(callback) {
  authListeners.add(callback);
  return () => authListeners.delete(callback);
}
