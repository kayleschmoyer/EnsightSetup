/**
 * RLS policy integration test — the single most important new test category
 * from the migration plan, since a broken RLS policy is silent data exposure
 * (wrong data readable/writable), not a crash something else would catch.
 *
 * Runs against a REAL local Supabase Postgres instance (`supabase start`,
 * see supabase/migrations/0002_storage_and_rls.sql for the policies under
 * test) — RLS is enforced by Postgres itself, so a mock can't meaningfully
 * verify it. Skipped automatically unless RLS_TEST_SUPABASE_URL /
 * RLS_TEST_SUPABASE_ANON_KEY are set, so it doesn't fail in environments
 * without the local stack running (e.g. a fresh checkout before `supabase
 * start`, or CI without Docker).
 *
 * To run for real: `supabase start`, then set
 *   RLS_TEST_SUPABASE_URL=http://127.0.0.1:54321
 *   RLS_TEST_SUPABASE_ANON_KEY=<anon key from `supabase status`>
 * and `npm run test -- rls.integration`.
 */
/* global process */
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const URL = process.env.RLS_TEST_SUPABASE_URL;
const ANON_KEY = process.env.RLS_TEST_SUPABASE_ANON_KEY;
const hasLocalStack = Boolean(URL && ANON_KEY);

// Node 20 (this project's pinned version, see .nvmrc) has no native
// WebSocket global, which @supabase/supabase-js's Realtime client needs even
// though these tests never use realtime — the browser client never hits this
// since browsers have native WebSocket.
function testClient() {
  return createClient(URL, ANON_KEY, { realtime: { transport: ws } });
}

describe.skipIf(!hasLocalStack)('Row Level Security (requires local Supabase stack)', () => {
  it('denies an anonymous (unauthenticated) client all access to customers', async () => {
    const anon = testClient();
    const { data, error } = await anon.from('customers').select('*');
    // RLS with no matching policy returns an empty set, not an error — the
    // real assertion is that nothing is exposed, not that it throws.
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const insertAttempt = await anon.from('customers').insert({
      customer_id: 'rls-test-anon', friendly_name: 'Should never land',
    });
    expect(insertAttempt.error).not.toBeNull();
  });

  it('denies a non-org-domain authenticated user', async () => {
    const client = testClient();
    // A local Supabase instance accepts unconfirmed signups by default; this
    // creates a session for an email outside @ensight-technologies.com.
    await client.auth.signUp({ email: 'outsider@example.com', password: 'test-password-123' });

    const { data, error } = await client.from('customers').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('allows an @ensight-technologies.com authenticated user to read and write', async () => {
    const client = testClient();
    await client.auth.signUp({
      email: 'staff-rls-test@ensight-technologies.com',
      password: 'test-password-123',
    });

    const { data: inserted, error: insertError } = await client
      .from('customers')
      .insert({ customer_id: 'rls-test-staff', friendly_name: 'RLS Test Customer' })
      .select()
      .single();
    expect(insertError).toBeNull();
    expect(inserted?.customer_id).toBe('rls-test-staff');

    const { data: readBack, error: readError } = await client
      .from('customers')
      .select('*')
      .eq('id', inserted.id);
    expect(readError).toBeNull();
    expect(readBack).toHaveLength(1);

    await client.from('customers').delete().eq('id', inserted.id);
  });
});
