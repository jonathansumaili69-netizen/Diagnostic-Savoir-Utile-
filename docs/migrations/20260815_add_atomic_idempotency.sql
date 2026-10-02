-- CONQUISTADOR OS — idempotence atomique
-- Migration additive et non destructive : aucune table, donnée, policy ou trigger
-- existant n’est supprimé ni réinitialisé.

create unique index if not exists uq_events_idempotency_scope_cle
  on public.events ((data->>'scope'), (data->>'cle'))
  where (data->>'type') = 'idempotency.marker';

create index if not exists idx_events_idempotency_lookup
  on public.events ((data->>'type'), (data->>'scope'), (data->>'cle'));

create or replace function public.claim_idempotency_event(p_scope text, p_cle text)
returns table(claimed boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_at timestamptz;
  existing_at timestamptz;
begin
  if nullif(trim(p_scope), '') is null or nullif(trim(p_cle), '') is null then
    raise exception 'scope et cle sont requis';
  end if;

  insert into public.events (data)
  values (
    jsonb_build_object(
      'type', 'idempotency.marker',
      'scope', p_scope,
      'cle', p_cle,
      'at', now()
    )
  )
  on conflict ((data->>'scope'), (data->>'cle'))
    where (data->>'type') = 'idempotency.marker'
    do nothing
  returning public.events.created_at into inserted_at;

  if inserted_at is not null then
    return query select true, inserted_at;
    return;
  end if;

  select e.created_at
    into existing_at
    from public.events e
   where e.data->>'type' = 'idempotency.marker'
     and e.data->>'scope' = p_scope
     and e.data->>'cle' = p_cle
   order by e.created_at asc
   limit 1;

  return query select false, existing_at;
end;
$$;

revoke all on function public.claim_idempotency_event(text, text) from public;
revoke execute on function public.claim_idempotency_event(text, text) from anon, authenticated;
grant execute on function public.claim_idempotency_event(text, text) to service_role;
