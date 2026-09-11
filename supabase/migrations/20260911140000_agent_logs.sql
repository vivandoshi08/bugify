-- Live agent console: one row per log line emitted by the autonomous agents (buyer / seller) and the
-- server's verifier. Written with the service key via POST /agent-logs; anon may read; Realtime streams inserts.
-- Rows older than 24 h are pruned by the server on boot.

create table public.agent_logs (
    id    bigserial primary key,
    agent text not null,                     -- 'buyer' | 'seller' | 'verifier'
    level text not null default 'info',      -- 'info' | 'tx' | 'warn'
    line  text not null,
    ts    timestamptz not null default now()
);

create index agent_logs_ts_idx on public.agent_logs (ts);

alter table public.agent_logs enable row level security;
create policy anon_read on public.agent_logs for select to anon, authenticated using (true);

-- Realtime: stream INSERTs to the board (guarded so re-running is a no-op).
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'agent_logs'
    ) then
        execute 'alter publication supabase_realtime add table public.agent_logs';
    end if;
end
$$;
