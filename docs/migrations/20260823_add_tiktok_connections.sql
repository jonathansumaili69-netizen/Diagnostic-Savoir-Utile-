-- CONQUISTADOR OS — TikTok Login Kit + Content Posting API (migration additive)
-- Ne supprime, ne réinitialise et ne modifie aucune table existante.
-- Les tokens TikTok seront chiffrés côté serveur avant insertion dans data.

create table if not exists public.tiktok_connections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists public.tiktok_oauth_states (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_set_updated_at'
      and tgrelid = 'public.tiktok_connections'::regclass
  ) then
    create trigger trg_set_updated_at
    before update on public.tiktok_connections
    for each row execute function public.set_updated_at();
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_set_updated_at'
      and tgrelid = 'public.tiktok_oauth_states'::regclass
  ) then
    create trigger trg_set_updated_at
    before update on public.tiktok_oauth_states
    for each row execute function public.set_updated_at();
  end if;
end $$;

create unique index if not exists uq_tiktok_connections_active_key
  on public.tiktok_connections ((data->>'connection_key'))
  where data->>'status' = 'active';

create unique index if not exists uq_tiktok_oauth_states_hash
  on public.tiktok_oauth_states ((data->>'state_hash'));

create index if not exists idx_tiktok_connections_status
  on public.tiktok_connections ((data->>'status'));

create index if not exists idx_tiktok_oauth_states_status_expiry
  on public.tiktok_oauth_states ((data->>'status'), (data->>'expires_at'));

alter table public.tiktok_connections enable row level security;
alter table public.tiktok_oauth_states enable row level security;

-- Aucun accès public : le backend Netlify utilise uniquement service_role.
-- Aucune policy anon/authenticated n’est créée volontairement.
