-- Let the public board discover the verifier API at runtime (the demo tunnel URL changes per launch).
drop policy if exists meta_public_read on public.meta;
create policy meta_public_read on public.meta
  for select to anon, authenticated
  using (key in ('lastIndexedBlock', 'lastIndexedAt', 'serverUrl'));
