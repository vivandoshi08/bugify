-- Bazaar schema: docs/ARCHITECTURE.md §7 (plus indexer/dispute columns).
-- health_checks (from *_init.sql) is intentionally kept: scripts/verify-services.ts uses it.
-- Wei amounts are text to avoid bigint precision loss in JS.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.manifests (
    hash             text primary key,
    name             text not null,
    model            text not null,
    body             jsonb not null,            -- PRIVATE: system prompt, tools, mocks
    invariant_labels text[] not null,
    created_at       timestamptz default now()
);

create table public.bounties (
    id               bigint primary key,
    buyer            text not null,
    manifest_hash    text not null references public.manifests(hash),
    control_hash     text,
    rewards_wei      text[] not null,
    slots            int[] not null,
    expiry           timestamptz not null,
    min_bond_wei     text not null,
    k                int not null,
    control_tier_bps int not null,
    status           text not null default 'OPEN',
    escrow_wei       text default '0',
    pending          int not null default 0,
    tx_hash          text,
    block            bigint,
    created_at       timestamptz default now(),
    updated_at       timestamptz default now()
);

create table public.commits (
    id             bigint primary key,
    bounty_id      bigint not null references public.bounties(id),
    invariant      int not null,
    seq            int not null,
    seller         text not null,
    commitment     text not null,
    bond_wei       text not null,
    outcome        text not null default 'NONE',
    hits           int,
    breaks_control boolean,
    content_hash   text,
    trace_hash     text,
    attested_at    timestamptz,
    attest_tx      text,
    dispute        text not null default 'NONE',
    dispute_tx     text,
    disputer       text,
    resolve_tx     text,
    finalized      boolean not null default false,
    finalize_tx    text,
    reclaim_tx     text,
    paid_wei       text,
    commit_tx      text,
    created_at     timestamptz default now(),
    updated_at     timestamptz default now()
);

create table public.findings (
    commit_id  bigint primary key references public.commits(id),
    bounty_id  bigint not null,
    buyer      text not null,
    transcript jsonb not null,                  -- PRIVATE
    traces     jsonb not null,                  -- PRIVATE
    created_at timestamptz default now()
);

create table public.events (
    id         bigserial primary key,
    block      bigint,
    tx_hash    text,
    log_index  int,
    name       text,
    args       jsonb,
    created_at timestamptz default now(),
    -- Indexer upserts on (tx_hash, log_index) so re-scanning a block range is idempotent.
    constraint events_tx_hash_log_index_key unique (tx_hash, log_index)
);

create table public.meta (
    key   text primary key,
    value text
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index commits_bounty_id_idx on public.commits (bounty_id);
create index commits_seller_idx    on public.commits (seller);
create index events_block_idx      on public.events (block);
create index events_name_idx       on public.events (name);

-- ---------------------------------------------------------------------------
-- public_bounties view
-- ---------------------------------------------------------------------------
-- Deliberately a default (security_invoker = false) view: it runs with the
-- privileges of its owner (postgres), NOT the caller, so anon/authenticated can
-- read the bounties ⋈ manifests join even though `manifests` has RLS enabled
-- with no anon policy. The column list is explicit so `manifests.body` (the
-- private system prompt / tools / mocks) can never leak through this view.
-- Do NOT switch this to security_invoker = true without adding a manifests
-- select policy, or the view will return nothing for the browser.

create view public.public_bounties
    with (security_invoker = false) as
select
    b.id,
    b.buyer,
    b.manifest_hash,
    b.control_hash,
    b.rewards_wei,
    b.slots,
    b.expiry,
    b.min_bond_wei,
    b.k,
    b.control_tier_bps,
    b.status,
    b.escrow_wei,
    b.pending,
    b.tx_hash,
    b.block,
    b.created_at,
    b.updated_at,
    m.name,
    m.model,
    m.invariant_labels
from public.bounties b
join public.manifests m on m.hash = b.manifest_hash;

comment on view public.public_bounties is
    'bounties joined with manifests(name, model, invariant_labels). Owner-privilege (security_invoker=false) view so anon can read it although manifests is service-key only; never add manifests.body here.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.manifests enable row level security;   -- no anon/authenticated policy: service key only
alter table public.findings  enable row level security;   -- no anon/authenticated policy: service key only
alter table public.meta      enable row level security;   -- no policies

alter table public.bounties enable row level security;
create policy anon_read on public.bounties for select to anon, authenticated using (true);

alter table public.commits enable row level security;
create policy anon_read on public.commits for select to anon, authenticated using (true);

alter table public.events enable row level security;
create policy anon_read on public.events for select to anon, authenticated using (true);

grant select on public.public_bounties to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: commits, events, bounties
-- ---------------------------------------------------------------------------

do $$
declare
    t text;
begin
    foreach t in array array['commits', 'events', 'bounties'] loop
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = t
        ) then
            execute format('alter publication supabase_realtime add table public.%I', t);
        end if;
    end loop;
end
$$;
