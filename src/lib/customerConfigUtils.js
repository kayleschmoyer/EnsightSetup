/**
 * Every customer is a Supabase row now — there's no more "not yet linked to a
 * Drive file" state a customer can be in, so both gates just check the row
 * exists. Kept as functions (rather than inlining `Boolean(customer?.id)` at
 * each call site) since ~10 components still call these to gate save/share UI.
 */
export function customerHasConfigFile(customer) {
  return Boolean(customer?.id);
}

export function customerCanSyncToSheet(customer) {
  return Boolean(customer?.id);
}
