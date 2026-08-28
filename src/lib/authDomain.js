/**
 * Single source of truth for the org-domain gate — imported by both the
 * client auth service (src/services/GoogleAuthService.js) and the server
 * session verifier (api/_auth.js), so the allowed domain never drifts
 * between the two. Dependency-free, same reasoning as customerRowMapping.js.
 */
export const ALLOWED_EMAIL_DOMAIN = 'ensight-technologies.com';

export function isEnsightEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}
