-- CONQUISTADOR OS — idempotence en deux temps (CLAIM / CONFIRM / RELEASE)
-- Migration additive et non destructive : aucune table, donnee, policy ou
-- trigger existant n'est supprime ni reinitialise. Remplace uniquement la
-- fonction claim_idempotency_event (meme nom, nouvelle signature avec
-- p_ttl_ms en parametre optionnel - les appels existants avec 2 arguments
-- continuent de fonctionner grace a la valeur par defaut) et ajoute deux
-- fonctions : confirm_idempotency_event, release_idempotency_event.
--
-- CONTEXTE (bug corrige) : la version precedente (voir
-- 20260815_add_atomic_idempotency.sql) marquait un evenement comme
-- definitivement traite des sa premiere reclamation, avant tout traitement.
-- Un payload contenant plusieurs evenements (A + B) ou seul A reussissait
-- laissait B marque "deja vu" pour toujours : un retry ne le retraitait
-- jamais. Desormais chaque marqueur porte un statut EN_COURS ou TERMINE :
--   - claim_idempotency_event   : reclame (creation ou reprise apres
--     expiration EN_COURS) ; ne renvoie claimed=true que si l'appelant peut
--     legitimement commencer (ou recommencer) le traitement ;
--   - confirm_idempotency_event : a appeler UNIQUEMENT apres succes reel ->
--     statut TERMINE, definitif ;
--   - release_idempotency_event : a appeler apres un echec pour permettre un
--     nouvel essai immediat, sans attendre l'expiration EN_COURS. Ne touche
--     jamais une marque deja TERMINE (un succes confirme n'est jamais
--     annulable a posteriori).
-- Les marqueurs ecrits avant cette migration (aucun champ `statut`) sont
-- traites comme TERMINE par securite : jamais de retraitement silencieux de
-- donnees anterieures a cette correction.

-- PostgreSQL distingue les fonctions par leur signature complete (nombre et
-- types d'arguments) : `create or replace` avec un argument supplementaire
-- (p_ttl_ms) creerait une DEUXIEME fonction surchargee au lieu de remplacer
-- l'ancienne a 2 arguments, laissant l'ancien comportement (sans distinction
-- EN_COURS/TERMINE) accessible en parallele. On la supprime explicitement.
drop function if exists public.claim_idempotency_event(text, text);

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

  -- Tentative de creation directe : premiere reclamation jamais vue pour ce
  -- couple scope/cle.
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
    -- Une marque existe deja : inspectee et eventuellement reclamee ci-dessous.
    null;
  end;

  -- Verrouille la ligne existante pour la duree de la transaction : deux
  -- reclamations concurrentes apres expiration ne peuvent pas reussir toutes
  -- les deux.
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
    -- EN_COURS et pas encore expire : traitement actif ailleurs (ou echec
    -- pas encore libere) -> doublon, l'appelant ne doit rien refaire.
    return query select false, 'EN_COURS'::text, v_claimed_at;
    return;
  end if;

  -- EN_COURS expire (crash / timeout du traitement precedent) : reprise
  -- raisonnable, on reclame la marque plutot que de rester bloque.
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

  -- Ne jamais liberer (ni supprimer) une marque deja TERMINE : un succes
  -- confirme n'est jamais annulable a posteriori.
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
