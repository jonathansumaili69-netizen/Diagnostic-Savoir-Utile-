-- ============================================================================
-- CONQUISTADOR OS - Schema Supabase (PostgreSQL)
-- ============================================================================
-- A executer dans Supabase > SQL Editor (projet gratuit). Ce schema est
-- volontairement generique (id / created_at / updated_at / data jsonb) pour
-- rester simple a maintenir : chaque collection memoire (voir
-- src/core/memory.js) devient une table avec la meme structure.
--
-- STATUT : le schema initial est applique et verifie sur le projet Supabase
-- dedie "conquistador-os" (project_id sgbaltdxjdxlrqsefekf, region
-- eu-central-1, URL https://sgbaltdxjdxlrqsefekf.supabase.co). Deux
-- migrations additives ont ensuite complete l'idempotence : l'index unique
-- de deduplication et le premier claim atomique (voir
-- docs/migrations/20260815_add_atomic_idempotency.sql), puis la distinction
-- EN_COURS/TERMINE avec confirm/release (voir
-- docs/migrations/20260914_idempotency_claim_confirm_release.sql). Une
-- troisieme migration additive a ajoute la table video_jobs (voir
-- docs/migrations/20260915_video_jobs.sql, Video Engine). La
-- section IDEMPOTENCE ci-dessous reflete deja l'etat final des deux. Ce
-- fichier reste une reference reproductible pour un autre environnement : ne
-- pas reexecuter le schema initial sur la production existante. Le linter
-- Supabase peut afficher
-- la notice informative "RLS enabled, no policy" : elle est volontaire car le
-- backend utilise exclusivement la cle service_role, jamais une cle anon.
--
-- Apres execution, definir SUPABASE_URL et SUPABASE_SERVICE_KEY dans les
-- variables d'environnement (.env ou Netlify) pour activer ce backend. Avec ces
-- variables, Supabase devient la memoire persistante reelle ; une erreur
-- Supabase est remontee et ne bascule plus silencieusement vers JSON. Sans
-- variables, le fallback JSON reste disponible pour le developpement local.
-- SUPABASE_SERVICE_KEY (cle service_role) ne peut pas etre recuperee
-- automatiquement pour des raisons de securite : voir SETUP.md etape 4 pour
-- la recuperer manuellement depuis le tableau de bord Supabase.
-- ============================================================================

create extension if not exists "pgcrypto";

-- Fonction utilitaire : met a jour updated_at automatiquement.
-- search_path fixe explicitement (chaine vide) : corrige l'avertissement de
-- securite "function_search_path_mutable" du linter Supabase (une fonction
-- sans search_path fixe est vulnerable a un detournement de search_path par
-- un role disposant de droits de creation de schema).
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql
set search_path = '';

-- Modele reutilise pour chaque collection : events, tasks, contacts, content,
-- metrics, decisions, errors, learnings, approvals, executions.
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists content (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists metrics (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists errors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists learnings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

create table if not exists executions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

-- Triggers updated_at pour chaque table.
do $$
declare
  t text;
begin
  foreach t in array array['events','tasks','contacts','content','metrics','decisions','errors','learnings','approvals','executions']
  loop
    execute format('drop trigger if exists trg_set_updated_at on %I;', t);
    execute format('create trigger trg_set_updated_at before update on %I for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- Index utiles pour les tris/filtres les plus frequents (rapport quotidien,
-- tableau de bord, historique).
create index if not exists idx_events_created_at on events (created_at desc);
create index if not exists idx_tasks_created_at on tasks (created_at desc);
create index if not exists idx_tasks_status on tasks ((data->>'status'));
create index if not exists idx_contacts_identifiant on contacts ((data->>'identifiant'));
create index if not exists idx_metrics_at on metrics ((data->>'at'));
create index if not exists idx_approvals_status on approvals ((data->>'status'));
create index if not exists idx_executions_date on executions ((data->>'date'));

-- ============================================================================
-- SECURITE (Row Level Security)
-- ============================================================================
-- Le backend Netlify utilise la cle SERVICE_ROLE (SUPABASE_SERVICE_KEY), qui
-- contourne RLS par conception : c'est la cle serveur, jamais exposee au
-- navigateur. RLS est tout de meme active ci-dessous par prudence, avec zero
-- politique publique : aucune requete cote client (cle anonyme) ne pourra
-- lire ou ecrire ces tables. Ne jamais utiliser la cle "anon" pour ce projet.
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['events','tasks','contacts','content','metrics','decisions','errors','learnings','approvals','executions']
  loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;


-- =========================================================================
-- IDEMPOTENCE (migrations additives 20260815 + 20260914)
-- =========================================================================
-- Les marqueurs d'idempotence sont conserves dans events sans ajouter de
-- table. L'unicite partielle empeche deux claims concurrents pour le meme
-- scope/cle ; l'index composite accelere les recherches de diagnostic.
-- Chaque marqueur porte un statut EN_COURS ou TERMINE : claim reclame
-- (creation ou reprise apres expiration EN_COURS), confirm transitionne vers
-- TERMINE (definitif, uniquement apres succes reel du traitement appelant),
-- release libere un EN_COURS en echec pour un nouvel essai immediat (ne
-- touche jamais un TERMINE). Voir docs/migrations/20260914_idempotency_claim_confirm_release.sql
-- pour le detail et le contexte du bug corrige par cette distinction.
create unique index if not exists uq_events_idempotency_scope_cle
  on events ((data->>'scope'), (data->>'cle'))
  where data->>'type' = 'idempotency.marker';

create index if not exists idx_events_idempotency_lookup
  on events ((data->>'type'), (data->>'scope'), (data->>'cle'));

create or replace function public.claim_idempotency_event(
  p_scope text,
  p_cle text,
  p_ttl_ms bigint default 600000
)
returns table(claimed boolean, statut text, first_claimed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_data jsonb;
  v_created_at timestamptz;
  v_statut text;
  v_claimed_at timestamptz;
  v_now timestamptz := now();
begin
  if nullif(trim(p_scope), '') is null or nullif(trim(p_cle), '') is null then
    raise exception 'scope et cle sont requis';
  end if;

  begin
    insert into public.events (data)
    values (
      jsonb_build_object(
        'type', 'idempotency.marker',
        'scope', p_scope,
        'cle', p_cle,
        'statut', 'EN_COURS',
        'claimed_at', v_now,
        'confirmed_at', null,
        'at', v_now
      )
    )
    returning id, created_at into v_id, v_created_at;
    return query select true, 'EN_COURS'::text, v_created_at;
    return;
  exception when unique_violation then
    null;
  end;

  select e.id, e.data, e.created_at
    into v_id, v_data, v_created_at
    from public.events e
   where e.data->>'type' = 'idempotency.marker'
     and e.data->>'scope' = p_scope
     and e.data->>'cle' = p_cle
   for update;

  v_statut := coalesce(v_data->>'statut', 'TERMINE');
  v_claimed_at := coalesce((v_data->>'claimed_at')::timestamptz, v_created_at);

  if v_statut = 'TERMINE' then
    return query select false, 'TERMINE'::text, coalesce((v_data->>'confirmed_at')::timestamptz, v_claimed_at);
    return;
  end if;

  if v_now - v_claimed_at < make_interval(secs => p_ttl_ms / 1000.0) then
    return query select false, 'EN_COURS'::text, v_claimed_at;
    return;
  end if;

  update public.events
     set data = data || jsonb_build_object('claimed_at', v_now, 'reclaimed', true)
   where id = v_id;

  return query select true, 'EN_COURS'::text, v_now;
end;
$$;

create or replace function public.confirm_idempotency_event(p_scope text, p_cle text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if nullif(trim(p_scope), '') is null or nullif(trim(p_cle), '') is null then
    raise exception 'scope et cle sont requis';
  end if;

  select e.id into v_id
    from public.events e
   where e.data->>'type' = 'idempotency.marker'
     and e.data->>'scope' = p_scope
     and e.data->>'cle' = p_cle
   for update;

  if v_id is null then
    return false;
  end if;

  update public.events
     set data = data || jsonb_build_object('statut', 'TERMINE', 'confirmed_at', now())
   where id = v_id;

  return true;
end;
$$;

create or replace function public.release_idempotency_event(p_scope text, p_cle text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_statut text;
begin
  if nullif(trim(p_scope), '') is null or nullif(trim(p_cle), '') is null then
    raise exception 'scope et cle sont requis';
  end if;

  select e.id, e.data->>'statut' into v_id, v_statut
    from public.events e
   where e.data->>'type' = 'idempotency.marker'
     and e.data->>'scope' = p_scope
     and e.data->>'cle' = p_cle
   for update;

  if v_id is null or v_statut = 'TERMINE' then
    return false;
  end if;

  delete from public.events where id = v_id;
  return true;
end;
$$;

revoke all on function public.claim_idempotency_event(text, text, bigint) from public;
revoke execute on function public.claim_idempotency_event(text, text, bigint) from anon, authenticated;
grant execute on function public.claim_idempotency_event(text, text, bigint) to service_role;

revoke all on function public.confirm_idempotency_event(text, text) from public;
revoke execute on function public.confirm_idempotency_event(text, text) from anon, authenticated;
grant execute on function public.confirm_idempotency_event(text, text) to service_role;

revoke all on function public.release_idempotency_event(text, text) from public;
revoke execute on function public.release_idempotency_event(text, text) from anon, authenticated;
grant execute on function public.release_idempotency_event(text, text) to service_role;

-- =========================================================================
-- VIDEO JOBS (migration additive 20260915 — Video Engine)
-- =========================================================================
-- Voir docs/migrations/20260915_video_jobs.sql pour le detail. Table dediee
-- (meme modele generique id/created_at/updated_at/data jsonb) car les jobs
-- video ont un cycle de vie et des requetes propres (liste par statut pour
-- le worker de rendu externe, recherche par cle d'idempotence).
create table if not exists video_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

drop trigger if exists trg_set_updated_at on video_jobs;
create trigger trg_set_updated_at before update on video_jobs
  for each row execute function set_updated_at();

create index if not exists idx_video_jobs_created_at on video_jobs (created_at desc);
create index if not exists idx_video_jobs_status on video_jobs ((data->>'status'));
create unique index if not exists uq_video_jobs_idempotency_key
  on video_jobs ((data->>'idempotency_key'))
  where data->>'idempotency_key' is not null;

alter table video_jobs enable row level security;
