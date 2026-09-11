-- Make the read-only board explain itself without widening the privacy model.
--
--   commits.verification        secret-free record of what the verifier did (k, hits, per-replay
--                               tool NAMES + redacted evidence, control result) or { reason } for
--                               attests that never replayed (commitment mismatch / reveal timeout).
--   manifests.invariant_summaries  one plain-English sentence per invariant, never the canary text.
--   meta                        anon may read the indexer heartbeat keys only.
--
-- manifests.body and findings.* stay service-key only.

alter table public.commits add column verification jsonb;
comment on column public.commits.verification is
    'Secret-free verification record: { k, hits, replays[{hit, toolCalls (names only), turns, evidence (redacted)}], breaksControl, control? } or { reason }. Never tool args, prompts or canary text.';

alter table public.manifests add column invariant_summaries text[] not null default '{}';
comment on column public.manifests.invariant_summaries is
    'One plain-English sentence per invariant (same order as invariant_labels). Secret-free; exposed through public_bounties.';

-- ---------------------------------------------------------------------------
-- public_bounties: same explicit column list + invariant_summaries. Still never body.
-- ---------------------------------------------------------------------------

drop view if exists public.public_bounties;

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
    m.invariant_labels,
    m.invariant_summaries
from public.bounties b
join public.manifests m on m.hash = b.manifest_hash;

comment on view public.public_bounties is
    'bounties joined with manifests(name, model, invariant_labels, invariant_summaries). Owner-privilege (security_invoker=false) view so anon can read it although manifests is service-key only; never add manifests.body here.';

grant select on public.public_bounties to anon, authenticated;

-- ---------------------------------------------------------------------------
-- meta: indexer heartbeat is public, nothing else in the table is.
-- ---------------------------------------------------------------------------

create policy anon_read_indexer_heartbeat on public.meta
    for select to anon, authenticated
    using (key in ('lastIndexedBlock', 'lastIndexedAt'));
