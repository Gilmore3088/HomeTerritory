-- The schema has always relied on the local/hosted stack's default
-- privileges to give service_role its table access; migrations only ever
-- granted functions explicitly. Newer Supabase CLI stacks (seen first on
-- CI's `engine` job) no longer supply those defaults for migration-created
-- tables, so every direct table read under the secret key failed with
-- 42501 while RPCs kept working. Make the schema self-sufficient: grant
-- service_role full table/sequence access explicitly, for existing objects
-- and (via default privileges for the migration role) future ones.
-- Idempotent and a no-op wherever the stack already provides these grants.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
