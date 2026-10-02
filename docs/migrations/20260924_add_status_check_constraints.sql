-- CONQUISTADOR OS — contraintes d'integrite sur les statuts (migration additive)
-- Deja applique en direct sur le projet Supabase "conquistador-os"
-- (sgbaltdxjdxlrqsefekf) le 2026-09-24. Ce fichier documente la migration
-- dans le depot pour rester reproductible sur un autre environnement.
--
-- CONTEXTE (audit) : le modele generique (data jsonb) n'imposait aucune
-- contrainte sur les valeurs de "status" ecrites par le code. Les enums
-- ci-dessous ont ete extraits directement du code source (source de
-- verite, voir mission) :
--   - tasks.status         : src/core/taskEngine.js (VALID_STATUSES)
--   - approvals.status     : src/core/approval.js
--   - *_connections.status : src/core/metaStore.js, youtubeStore.js, tiktokStore.js
--   - *_oauth_states.status: idem
--   - video_jobs.status    : src/core/videoJobs.js (STATUSES)
-- Verifies avant application contre les donnees live de chaque table :
-- aucune valeur existante ne violait ces enums (donc application directe,
-- sans NOT VALID). NULL reste autorise par prudence (aucun chemin de code
-- identifie n'omet le champ, mais on ne bloque pas une eventuelle omission
-- future) ; seule une valeur hors enum (bug/typo applicatif) est desormais
-- rejetee au niveau base plutot que de corrompre silencieusement une
-- machine a etats.
--
-- Non destructif : n'affecte aucune donnee existante (conforme par
-- construction), ni les operations d'ecriture actuelles du code.

alter table public.tasks
  add constraint chk_tasks_status
  check (data->>'status' is null or data->>'status' in
    ('pending','running','waiting_approval','done','error','rejected','blocked'));

alter table public.approvals
  add constraint chk_approvals_status
  check (data->>'status' is null or data->>'status' in
    ('pending','approved','rejected','expired','auto_approved'));

alter table public.meta_connections
  add constraint chk_meta_connections_status
  check (data->>'status' is null or data->>'status' in ('active','revoked'));

alter table public.meta_oauth_states
  add constraint chk_meta_oauth_states_status
  check (data->>'status' is null or data->>'status' in ('pending','expired','consumed'));

alter table public.youtube_connections
  add constraint chk_youtube_connections_status
  check (data->>'status' is null or data->>'status' in ('active','revoked'));

alter table public.youtube_oauth_states
  add constraint chk_youtube_oauth_states_status
  check (data->>'status' is null or data->>'status' in ('pending','expired','consumed'));

alter table public.tiktok_connections
  add constraint chk_tiktok_connections_status
  check (data->>'status' is null or data->>'status' in ('active','revoked'));

alter table public.tiktok_oauth_states
  add constraint chk_tiktok_oauth_states_status
  check (data->>'status' is null or data->>'status' in ('pending','expired','consumed'));

alter table public.video_jobs
  add constraint chk_video_jobs_status
  check (data->>'status' is null or data->>'status' in
    ('QUEUED','PREPARING','GENERATING_SCRIPT','PREPARING_REFERENCES',
     'GENERATING_ASSETS','GENERATING_VOICE','BUILDING_TIMELINE','COMPOSING',
     'RENDERING','QUALITY_CHECK','COMPLETED','READY','SCHEDULED',
     'PUBLISHING','PUBLISHED','FAILED','CANCELLED'));
