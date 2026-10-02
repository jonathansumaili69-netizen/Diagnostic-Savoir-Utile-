'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conquistador-test-agents-'));
process.env.CONQUISTADOR_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.NETLIFY;
delete process.env.LAMBDA_TASK_ROOT;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

const agents = require('../src/agents');
const qualite = require('../src/agents/qualite');
const statistiques = require('../src/agents/statistiques');
const clients = require('../src/agents/clients');
const contenu = require('../src/agents/contenu');
const systemActions = require('../src/agents/systemActions');
const videoQuality = require('../src/agents/videoQuality');
const operationalState = require('../src/core/operationalState');
const { config } = require('../src/core/config');
const socialConnectors = require('../src/core/socialConnectors');

/* --- Registre ------------------------------------------------------------*/

test('agents.resolve: type connu renvoie domaine/sous-type/actionType corrects', () => {
  const r = agents.resolve('content.idea');
  assert.equal(r.domain, 'content');
  assert.equal(r.subtype, 'idea');
  assert.equal(r.actionType, 'GENERATE_IDEA');
  assert.equal(typeof r.module.handle, 'function');
});

test('agents.resolve: domaine inconnu leve une erreur explicite', () => {
  assert.throws(() => agents.resolve('inconnu.sous_type'), /Domaine d'agent inconnu/);
});

test('agents.parseType: format invalide (sans point) leve une erreur', () => {
  assert.throws(() => agents.parseType('typeinvalide'), /format attendu/);
});

test('agents.listTaskTypes: contient tous les types documentes cote dashboard', () => {
  const types = agents.listTaskTypes();
  assert.ok(types.includes('content.full_video'));
  assert.ok(types.includes('pipeline.video'));
  assert.ok(types.includes('content.revise'));
  assert.ok(types.includes('system.send_message'));
  assert.ok(types.includes('directeur.priorities'));
});

/* --- AGENT_QUALITE (deterministe, sans IA) --------------------------------*/

test('qualite.review: signale un personnage non officiel', () => {
  const result = qualite.review({
    content: { scenes: [{ personnage: 'Jean-Michel', cta: 'x' }] },
  });
  assert.equal(result.output.conforme, false);
  assert.ok(result.output.problemes.some((p) => p.includes('Jean-Michel')));
});

test('qualite.review: accepte Samuel et Marc comme personnages officiels', () => {
  const result = qualite.review({
    content: { hook: 'accroche', script: 'texte', cta: 'lien', scenes: [{ personnage: 'Samuel' }] },
  });
  assert.equal(result.output.conforme, true);
  assert.deepEqual(result.output.problemes, []);
});

test('qualite.review: signale l\'absence de CTA quand un script est present', () => {
  const result = qualite.review({ content: { script: 'texte sans cta' } });
  assert.equal(result.output.conforme, false);
  assert.ok(result.output.problemes.some((p) => p.toLowerCase().includes('cta')));
});

test('video.review: refuse honnêtement une vidéo sans URL ni manifeste', async () => {
  const result = await videoQuality.review({ use_ai: false, video: {} });
  assert.equal(result.type, 'video.review');
  assert.equal(result.output.conforme, false);
  assert.equal(result.output.publication_autorisee, false);
  assert.ok(result.output.problemes.some((p) => p.includes('URL vidéo HTTPS')));
  assert.ok(result.output.problemes.some((p) => p.includes('Manifeste textuel')));
  assert.equal(result.output.media_binaire_inspecte, false);
});

test('video.review: les métadonnées seules ne valident jamais une vidéo', async () => {
  const result = await videoQuality.review({
    use_ai: false,
    video: {
      source_url: 'https://cdn.example.test/video.mp4',
      duration_seconds: 45,
      width: 1080,
      height: 1920,
      mime_type: 'video/mp4',
      script: 'Conseil éducatif pour améliorer son CV.',
      captions: ['Un conseil utile'],
      cta: 'Découvre la suite.',
    },
  });
  assert.equal(result.output.publication_autorisee, false);
  assert.equal(result.output.media_binaire_inspecte, false);
  assert.equal(result.output.conforme, false);
  assert.deepEqual(result.output.problemes, []);
  assert.ok(result.output.preuves_manquantes.some((p) => p.includes('Inspection audiovisuelle')));
  assert.ok(result.output.evidence_scope.includes('textual_manifest'));
});

test('video.review: accepte une inspection Gemini vidéo réussie sans autoriser la publication', async () => {
  const previousFetch = global.fetch;
  const previousKey = config.ai.geminiApiKey;
  const previousModel = config.ai.geminiModel;
  config.ai.geminiApiKey = 'test-only-not-a-real-secret';
  config.ai.geminiModel = 'gemini-2.5-flash';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], 'test-only-not-a-real-secret');
    const request = JSON.parse(options.body);
    assert.equal(request.input[0].type, 'video');
    assert.equal(request.input[0].uri, 'https://cdn.example.test/video.mp4');
    return {
      ok: true,
      async json() {
        return {
          outputs: [{ type: 'text', text: JSON.stringify({
            decision: 'APPROUVER_REVUE',
            bloquants: [],
            avertissements: ['Test simulé : validation humaine toujours requise.'],
            preuves_manquantes: [],
          }) }],
        };
      },
    };
  };
  try {
    const result = await videoQuality.review({
      use_ai: false,
      video: {
        source_url: 'https://cdn.example.test/video.mp4',
        duration_seconds: 45,
        width: 1080,
        height: 1920,
        mime_type: 'video/mp4',
        script: 'Conseil éducatif pour améliorer son CV.',
        platform: 'tiktok',
        cta: 'Découvre la suite dans le profil.',
        brand_style: 'Savoir Utile officiel',
        timeline: [{
          scene_id: 'scene_01',
          start_seconds: 0,
          end_seconds: 45,
          image_ref: 'image-scene-01',
          voice_start_seconds: 0,
          voice_end_seconds: 45,
          subtitles: [{ start_seconds: 0, end_seconds: 45, text: 'Un conseil utile' }],
        }],
      },
    });
    assert.equal(result.output.conforme, true);
    assert.equal(result.output.media_binaire_inspecte, true);
    assert.equal(result.output.publication_autorisee, true); // mode Conquistador : la publication est autorisee des que la revue valide la qualite
    assert.equal(result.provider, 'gemini');
    assert.ok(result.output.evidence_scope.includes('media_binaire_externe'));
  } finally {
    global.fetch = previousFetch;
    config.ai.geminiApiKey = previousKey;
    config.ai.geminiModel = previousModel;
  }
});

test('agents.resolve: pipeline.video utilise le module pipeline et une action de génération', () => {
  const r = agents.resolve('pipeline.video');
  assert.equal(r.domain, 'pipeline');
  assert.equal(r.subtype, 'video');
  assert.equal(r.actionType, 'GENERATE');
  assert.equal(typeof r.module.handle, 'function');
});

test('agents.resolve: video.review utilise le module vidéo et une action d’analyse', () => {
  const r = agents.resolve('video.review');
  assert.equal(r.domain, 'video');
  assert.equal(r.subtype, 'review');
  assert.equal(r.actionType, 'ANALYZE');
  assert.equal(typeof r.module.handle, 'function');
});

test('pipeline.video bloque une vidéo sans preuve durable et retourne le feedback de contrôle', async () => {
  const pipeline = require('../src/agents/pipeline');
  const result = await pipeline.run({
    sujet: 'Conseil pour améliorer son CV',
    use_ai_quality: false,
    use_media_ai: false,
    max_revisions: 0,
  });
  assert.equal(result.type, 'pipeline.video');
  assert.equal(result.output.conforme, false);
  assert.equal(result.output.publication_autorisee, false);
  assert.equal(result.output.statut, 'CORRECTIONS_REQUISES');
  assert.ok(result.output.revue_video.preuves_manquantes.some((item) => item.includes('Inspection audiovisuelle')));
  assert.equal(result.output.communication_agent_creatif.active, false);
});

test('operationalState: les paramètres de mode sont persistants et la campagne reste bornée', async () => {
  const copilot = await operationalState.setSettings({
    mode: 'copilot',
    campaign: { enabled: true, max_publications_per_day: 99, allowed_platforms: ['tiktok', 'inconnu'] },
  });
  assert.equal(copilot.mode, 'copilot');
  assert.equal(copilot.mode_policy.campaigns_allowed, false);
  assert.equal(copilot.mode_policy.external_actions_autonomous, false);
  assert.equal(copilot.campaign.enabled, false);
  assert.equal(copilot.campaign.max_publications_per_day, 20);
  assert.deepEqual(copilot.campaign.allowed_platforms, ['tiktok']);

  const conquistador = await operationalState.setSettings({
    mode: 'conquistador',
    campaign: { enabled: true, max_publications_per_day: 3, allowed_platforms: ['youtube'] },
  });
  assert.equal(conquistador.mode, 'conquistador');
  assert.equal(conquistador.mode_policy.campaigns_allowed, true);
  assert.equal(conquistador.mode_policy.approval_required, false); // autonomie reglee en mode Conquistador
  assert.equal(conquistador.campaign.enabled, true);
  const persisted = await operationalState.getSettings();
  assert.equal(persisted.mode, 'conquistador');
});

test('operationalState: une référence réelle est ajoutée de façon additive', async () => {
  const row = await operationalState.addKnowledge({
    title: 'Référence de test',
    category: 'test',
    content: 'Contenu réel de test conservé dans la collection content.',
    source_url: 'https://example.test/reference',
  }, { actor: 'test' });
  assert.equal(row.data.kind, 'knowledge_asset');
  const rows = await operationalState.listKnowledge({ limit: 20 });
  assert.ok(rows.some((item) => item.id === row.id));
});

/* --- AGENT_STATISTIQUES ---------------------------------------------------*/

test('statistiques.record puis summary agregent correctement', async () => {
  await statistiques.record({ vues: 100, ventes: 2, source: 'tiktok' });
  await statistiques.record({ vues: 50, ventes: 1, source: 'instagram' });
  const s = await statistiques.summary({ since: new Date(Date.now() - 3600 * 1000).toISOString() });
  assert.ok(s.output.totaux.vues >= 150);
  assert.ok(s.output.totaux.ventes >= 3);
});

/* --- AGENT_CLIENTS ---------------------------------------------------------*/

test('clients.upsertContact cree un contact puis le met a jour sans le dupliquer', async () => {
  const first = await clients.upsertContact({ identifiant: 'test-contact-1', canal: 'whatsapp', message: 'bonjour' });
  assert.equal(first.isNew, true);
  const second = await clients.upsertContact({ identifiant: 'test-contact-1', canal: 'whatsapp', message: 'suivi' });
  assert.equal(second.isNew, false);
  assert.equal(second.output.data.historique.length, 2);
});

test('clients.upsertContact leve une erreur sans identifiant', async () => {
  await assert.rejects(() => clients.upsertContact({}), /identifiant/);
});

/* --- AGENT_CONTENU (passe par le fournisseur IA en mode mock) -------------*/

test('contenu.idea renvoie une structure exploitable meme en mode mock', async () => {
  const result = await contenu.idea({ sujet: 'CV percutant' });
  assert.equal(result.type, 'content.idea');
  assert.equal(result.provider, 'mock');
  assert.ok(result.output.ok === false || result.output.ok === true);
});

/* --- SYSTEM_ACTIONS (ne doit jamais mentir sur une action externe) --------*/

test('systemActions.sendMessage sans connecteur renvoie explicitement NON_EXECUTE_AUCUNE_CONNEXION', async () => {
  const result = await systemActions.sendMessage({ canal: 'whatsapp', destinataire: 'x', message: 'salut' });
  assert.equal(result.output.statut, 'NON_EXECUTE_AUCUNE_CONNEXION');
});

test('systemActions.publishPost sans connecteur renvoie explicitement NON_EXECUTE_AUCUNE_CONNEXION', async () => {
  const result = await systemActions.publishPost({ plateforme: 'tiktok', contenu: 'x' });
  assert.equal(result.output.statut, 'NON_EXECUTE_AUCUNE_CONNEXION');
});

test('systemActions.publishPost bloque une vidéo non inspectée avant tout appel externe', async () => {
  const previous = socialConnectors.activeClientFor;
  let called = false;
  socialConnectors.activeClientFor = async () => ({
    publish: async () => {
      called = true;
      return { id: 'must-not-be-called' };
    },
  });
  try {
    const result = await systemActions.publishPost({
      plateforme: 'tiktok',
      video_url: 'https://cdn.example.test/video.mp4',
      duration_seconds: 45,
      script: 'Conseil éducatif pour améliorer son CV.',
      use_ai_quality: false,
      use_media_ai: false,
    });
    assert.equal(result.output.statut, 'NON_EXECUTE_QUALITE_VIDEO');
    assert.equal(called, false);
  } finally {
    socialConnectors.activeClientFor = previous;
  }
});

/* --- AUDIT régression : bug "[object Object]" sur le statut YouTube ------*/
/* YouTube renvoie un champ "status" qui est un OBJET ({ uploadStatus,
 * privacyStatus, ... }), pas une chaîne. Le statut interne ne doit jamais
 * réutiliser cet objet tel quel. */

test('systemActions.publishPost : uploadStatus "uploaded" (YouTube) -> statut interne PUBLIE, jamais un objet', async () => {
  const previous = socialConnectors.activeClientFor;
  socialConnectors.activeClientFor = async () => ({
    publish: async () => ({ id: 'yt-1', status: { uploadStatus: 'uploaded', privacyStatus: 'private' } }),
  });
  try {
    const result = await systemActions.publishPost({ plateforme: 'youtube', contenu: 'texte' });
    assert.equal(typeof result.output.statut, 'string');
    assert.equal(result.output.statut, 'PUBLIE');
    assert.notEqual(String(result.output.statut), '[object Object]');
  } finally {
    socialConnectors.activeClientFor = previous;
  }
});

test('systemActions.publishPost : uploadStatus "rejected"/"failed" (YouTube) -> ECHEC, jamais PUBLIE', async () => {
  const previous = socialConnectors.activeClientFor;
  for (const uploadStatus of ['rejected', 'failed', 'deleted']) {
    socialConnectors.activeClientFor = async () => ({
      publish: async () => ({ id: 'yt-2', status: { uploadStatus, privacyStatus: 'private' } }),
    });
    // eslint-disable-next-line no-await-in-loop
    const result = await systemActions.publishPost({ plateforme: 'youtube', contenu: 'texte' });
    assert.equal(result.output.statut, 'ECHEC', `uploadStatus=${uploadStatus}`);
  }
  socialConnectors.activeClientFor = previous;
});

test('systemActions.publishPost : status YouTube sans uploadStatus reste EN_TRAITEMENT (pas de PUBLIE non confirmé)', async () => {
  const previous = socialConnectors.activeClientFor;
  socialConnectors.activeClientFor = async () => ({
    publish: async () => ({ id: 'yt-3', status: { privacyStatus: 'private' } }),
  });
  try {
    const result = await systemActions.publishPost({ plateforme: 'youtube', contenu: 'texte' });
    assert.equal(result.output.statut, 'EN_TRAITEMENT');
  } finally {
    socialConnectors.activeClientFor = previous;
  }
});

test('systemActions.deriveStatut : ne renvoie jamais un objet brut comme statut interne', () => {
  const casObjet = systemActions.deriveStatut({ id: 'x', status: { uploadStatus: 'uploaded' } }, 'youtube');
  const casInconnu = systemActions.deriveStatut({ id: 'x', status: { uploadStatus: 'un_nouveau_statut_inconnu' } }, 'youtube');
  assert.equal(typeof casObjet, 'string');
  assert.equal(typeof casInconnu, 'string');
  assert.equal(casInconnu, 'EN_TRAITEMENT');
});

test('systemActions.publishPost : statut string explicite (TikTok) reste prioritaire et intact', async () => {
  const previous = socialConnectors.activeClientFor;
  socialConnectors.activeClientFor = async () => ({
    publish: async () => ({ id: 'tt-1', statut: 'EN_TRAITEMENT', provider_status: 'PROCESSING' }),
  });
  try {
    const result = await systemActions.publishPost({ plateforme: 'tiktok', contenu: 'texte' });
    assert.equal(result.output.statut, 'EN_TRAITEMENT');
  } finally {
    socialConnectors.activeClientFor = previous;
  }
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
