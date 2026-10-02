-- CONQUISTADOR OS — correction de la limite de taille du bucket Storage
-- Deja applique en direct sur le projet Supabase "conquistador-os"
-- (sgbaltdxjdxlrqsefekf) le 2026-09-24.
--
-- CONTEXTE (audit) : le bucket conquistador-media etait configure a
-- file_size_limit = 209715200 (200 Mo). L'organisation est sur le plan
-- Supabase FREE, et la documentation officielle Supabase (verifiee en
-- direct via l'outil de recherche de documentation) est explicite : sur le
-- plan Free, la limite globale de taille de fichier ne peut pas depasser
-- 50 Mo, quelle que soit la valeur configuree au niveau du bucket.
-- Un bucket annoncant 200 Mo alors que la plateforme rejette tout au-dela
-- de 50 Mo est une configuration trompeuse plutot qu'une limite basse :
-- elle laisse croire qu'un upload de 80 ou 150 Mo va reussir alors qu'il
-- sera rejete par la plateforme. Cette migration aligne la configuration
-- du bucket sur la limite reelle et atteignable.
--
-- Non destructif : ne supprime ni ne deplace aucun objet Storage existant.
-- Les objets deja stockes sous l'ancienne limite (200 Mo) ne sont pas
-- affectes retroactivement ; seuls les futurs uploads sont concernes.

update storage.buckets
set file_size_limit = 52428800 -- 50 Mo : plafond reel du plan Free
where id = 'conquistador-media';
