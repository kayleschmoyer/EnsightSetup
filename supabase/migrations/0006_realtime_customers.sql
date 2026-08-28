-- Realtime "doorbell": other open tabs re-fetch a customer when its row
-- changes. Only the customers table is published — every save path bumps the
-- parent row (saveCustomerFull's concurrency guard, updateCustomerInfo), so a
-- child-table change never happens without a customers UPDATE ringing the
-- bell. Events are delivered per-user through RLS, so signed-out clients hear
-- nothing.
alter publication supabase_realtime add table public.customers;
