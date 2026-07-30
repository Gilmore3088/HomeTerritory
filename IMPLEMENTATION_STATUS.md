# Implementation status

## Developed

The repository contains the application, database schema, RLS policies, authenticated RPC game engine, realtime subscriptions, seed data, PWA shell, cron route, and CI workflow.

## Requires owner authorization

A Supabase project and Vercel project must be created or connected by the repository owner. Those services require account-level authorization and credentials that should not be placed in chat or committed to GitHub.

Until those two projects are connected, the code is developed but there is no public multiplayer URL. Once the environment variables are set and the migration is applied, multiple accounts use the same database and map state.
