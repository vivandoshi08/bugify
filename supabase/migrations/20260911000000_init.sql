-- Smoke-test table used by scripts/verify-services.ts to prove read/write access.
create table if not exists public.health_checks (
    id uuid primary key default gen_random_uuid(),
    note text not null,
    created_at timestamptz not null default now()
);
alter table public.health_checks enable row level security;
-- Publishable key may read only; writes require the secret key.
create policy "health_checks_read" on public.health_checks for select using (true);
