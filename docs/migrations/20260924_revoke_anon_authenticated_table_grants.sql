-- CONQUISTADOR OS — defense en profondeur (migration additive)
-- Deja applique en direct sur le projet Supabase "conquistador-os"
-- (sgbaltdxjdxlrqsefekf) le 2026-09-24. Ce fichier documente la migration
-- dans le depot pour rester reproductible sur un autre environnement.
--
-- CONTEXTE (audit) : par defaut, Supabase accorde SELECT/INSERT/UPDATE/
-- DELETE/TRUNCATE/REFERENCES/TRIGGER aux roles "anon" et "authenticated"
-- sur TOUTES les tables du schema public, y compris celles creees par les
-- migrations precedentes de ce projet. Le backend Netlify n'authentifie
-- jamais ces roles (uniquement SUPABASE_SERVICE_KEY, voir memory.js) ;
-- seule la RLS (activee, sans policy) empechait l'acces reel. Cette
-- migration retire ce premier niveau de privilege explicitement : une
-- erreur future de RLS (table oubliee, policy ajoutee par erreur) ne
-- suffirait alors plus, seule, a exposer les donnees.
--
-- Non destructif : n'affecte aucune donnee, ni service_role, ni postgres,
-- ni le comportement actuel de l'application.

revoke all privileges on all tables in schema public from anon, authenticated;

-- S'applique aussi a toute future table creee dans le schema public par le
-- role courant (postgres/service_role), sans avoir a repeter ce REVOKE a
-- chaque nouvelle migration additive.
alter default privileges in schema public revoke all on tables from anon, authenticated;
