-- CONQUISTADOR OS — table video_jobs (Video Engine, migration additive)
-- Reutilise le meme modele generique (id/created_at/updated_at/data jsonb)
-- que les collections existantes (voir docs/supabase-schema.sql). Aucune
-- table existante n'est modifiee ou supprimee.
--
-- Un job video traverse les statuts :
--   QUEUED -> PREPARING -> GENERATING_ASSETS -> GENERATING_VOICE ->
--   COMPOSING -> RENDERING -> QUALITY_CHECK -> COMPLETED
-- ou a tout moment -> FAILED / CANCELLED.
-- Voir src/core/videoJobs.js et src/core/videoOrchestrator.js pour la
-- machine a etats et l'orchestration reelle.

create table if not exists video_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

drop trigger if exists trg_set_updated_at on video_jobs;
create trigger trg_set_updated_at before update on video_jobs
  for each row execute function set_updated_at();

-- Lecture frequente : liste des jobs par statut (le worker externe interroge
-- regulierement les jobs QUEUED/en cours), et retrouver un job par sa cle
-- d'idempotence (voir videoJobs.createJob) sans recreer un doublon.
create index if not exists idx_video_jobs_created_at on video_jobs (created_at desc);
create index if not exists idx_video_jobs_status on video_jobs ((data->>'status'));
create unique index if not exists uq_video_jobs_idempotency_key
  on video_jobs ((data->>'idempotency_key'))
  where data->>'idempotency_key' is not null;

alter table video_jobs enable row level security;
-- Aucune politique publique : uniquement accessible via la cle service_role
-- cote serveur (memes garanties que le reste du schema, voir la section
-- SECURITE de docs/supabase-schema.sql).
