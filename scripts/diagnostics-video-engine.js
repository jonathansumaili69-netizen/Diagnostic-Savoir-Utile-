'use strict';

/**
 * DIAGNOSTIC DU VIDEO ENGINE (script executable, lecture seule).
 *
 * Verifie et affiche, SANS RIEN MODIFIER :
 *   - disponibilite reelle de ffmpeg / ffprobe ;
 *   - integrite du Character Registry (references principales + versionnees) ;
 *   - etat de configuration des providers (image, image-to-image, voix, stockage) ;
 *   - etat du kill switch, du mode, de la campagne ;
 *   - jonction video_jobs -> scheduler (jobs candidats, tentatives, echeances) ;
 *   - limites reelles (ce qui necessite une infrastructure externe).
 *
 * Usage : node scripts/diagnostics-video-engine.js
 */

const videoRenderer = require('../src/core/videoRenderer');
const videoFileQualityCheck = require('../src/core/videoFileQualityCheck');
const characterRegistry = require('../src/core/characterRegistry');
const providerAdapter = require('../src/core/imageProviders/providerAdapter');
const imageProviders = require('../src/core/imageProviders');
const mediaStorage = require('../src/core/mediaStorage');
const voiceStudio = require('../src/core/voiceStudio');
const killswitch = require('../src/core/killswitch');
const operationalState = require('../src/core/operationalState');
const schedulerBridge = require('../src/core/schedulerBridge');
const videoJobs = require('../src/core/videoJobs');
const memory = require('../src/core/memory');

function line(label, value) {
  process.stdout.write(`${label.padEnd(38)} : ${value}\n`);
}

async function main() {
  process.stdout.write('\n=== DIAGNOSTIC CONQUISTADOR OS — VIDEO ENGINE ===\n\n');

  process.stdout.write('--- RENDU (ffmpeg / ffprobe) ---\n');
  const ffmpeg = await videoRenderer.isAvailable();
  const ffprobe = await videoFileQualityCheck.ffprobeAvailable();
  line('ffmpeg', ffmpeg ? 'DISPONIBLE' : 'ABSENT (rendu impossible ici)');
  line('ffprobe', ffprobe ? 'DISPONIBLE' : 'ABSENT (QC fichier impossible ici)');
  line('fps cible', process.env.VIDEO_FPS || '30 (defaut)');

  process.stdout.write('\n--- CHARACTER REGISTRY (identites officielles) ---\n');
  const integrity = characterRegistry.verifyIntegrity();
  line('integrite', integrity.ok ? 'OK — aucune reference manquante' : `PROBLEMES: ${JSON.stringify(integrity.problems)}`);
  for (const c of integrity.characters) {
    line(`  ${c.character_id}`, `principal=${c.references_principales} secondaires=${c.references_secondaires} statut=${c.statut_reference}`);
  }

  process.stdout.write('\n--- PROVIDERS ---\n');
  line('image-to-image (optionnel)', providerAdapter.configured() ? JSON.stringify(providerAdapter.status()) : `non configure — ${providerAdapter.status().raison}`);
  line('strategie sans img2img', JSON.stringify(characterRegistry.referenceStrategyFor('samuel', { providerCapabilities: {} }).strategy));
  const chain = imageProviders.buildProviderOrder({ personnage: 'Samuel' });
  line('chaine de repli Samuel', chain.join(' -> '));
  line('chaine de repli generique', imageProviders.buildProviderOrder({ personnage: 'aucun' }).join(' -> '));
  line('studio vocal', voiceStudio.studioBaseUrl() ? 'configure' : 'NON configure (voix off indisponible : statut VOICE_UNAVAILABLE, jamais de faux audio)');
  line('stockage durable', mediaStorage.configured() ? `configure (bucket ${mediaStorage.DEFAULT_BUCKET})` : 'NON configure (rendu valide mais job non COMPLETED, honnetement)');

  process.stdout.write('\n--- SECURITE / MODES ---\n');
  const settings = await operationalState.getSettings();
  const kill = await killswitch.getStatus();
  line('mode', settings.mode);
  line('campagne', settings.campaign && settings.campaign.enabled ? 'activee' : 'inactive');
  line('kill switch', kill.engage ? `ENGAGE (${kill.raison || 'sans raison'})` : 'desengage');
  line('actions externes bloquees', [...killswitch.EXTERNAL_ACTION_TYPES].join(', '));
  line('backend memoire', memory.backend ? memory.backend() : 'json (fallback local)');

  process.stdout.write('\n--- JONCTION video_jobs -> scheduler ---\n');
  const diag = await schedulerBridge.diagnostics();
  line('tentatives max diffusion', diag.max_tentatives);
  line('jobs video dus', diag.jobs_dus);
  for (const j of diag.detail) {
    line(`  job ${j.job_id.slice(0, 8)}`, `statut=${j.status} plateforme=${j.platform} echeance=${j.scheduled_for || 'immediate'} tentatives=${j.attempts}`);
  }
  const all = await videoJobs.listJobs({ limit: 200 });
  const byStatus = all.reduce((acc, j) => { acc[j.status] = (acc[j.status] || 0) + 1; return acc; }, {});
  line('jobs video enregistres', Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ') || 'aucun');

  process.stdout.write('\n--- LIMITES (infrastructure externe requise) ---\n');
  process.stdout.write("  - Rendu FFmpeg reel a duree longue : fonctionne ICI et sur tout hote disposant d'ffmpeg (worker externe ou machine locale).\n");
  process.stdout.write("  - Les fonctions Netlify standard ont un timeout d'execution : un rendu long doit passer par le worker (scripts/render-worker.js).\n");
  process.stdout.write("  - Publication reelle TikTok/YouTube/Facebook/Instagram : exige des comptes OAuth configures (non verifiable sans eux).\n");
  process.stdout.write("  - Voix off reelle : exige VOICE_STUDIO_API_URL (sinon VOICE_UNAVAILABLE explicite, aucun audio fabrique).\n");
  process.stdout.write("  - Stockage durable des rendus : exige Supabase Storage (sinon job non COMPLETED, honnetement signale).\n");
  process.stdout.write("  - Generation d'images conditionnee par reference : exige une cle API d'un provider image-to-image (optionnel).\n\n");
}

main().catch((err) => {
  process.stdout.write(`ECHEC DIAGNOSTIC: ${err.message}\n`);
  process.exit(1);
});
