'use strict';

/**
 * Configuration centrale de Conquistador OS.
 * Toutes les variables sensibles proviennent exclusivement de process.env.
 * Aucun secret n'est jamais ecrit en dur dans le code.
 */

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true' || value === '1';
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const isProduction = bool(process.env.NETLIFY, false) || process.env.CONTEXT === 'production';

const config = {
  apiKey: process.env.CONQUISTADOR_API_KEY || '',

  ai: {
    groqApiKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    // gemini-2.0-flash a ete retire le 3 mars 2026 ; gemini-2.5-flash est le
    // choix gratuit recommande a la date de redaction (aout 2026). Verifier
    // https://ai.google.dev/pricing si ce nom de modele venait a changer.
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    // OpenRouter : troisieme fournisseur gratuit (voir docs/AI_PROVIDERS.md
    // pour la justification). Le roster de modeles ":free" tourne dans le
    // temps ; verifier https://openrouter.ai/models?max_price=0 si ce nom
    // de modele devient indisponible.
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openrouterModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  },

  memory: {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
    jsonDataDir: process.env.CONQUISTADOR_DATA_DIR || 'data',
    // Fenetre "EN_COURS" d'un marqueur d'idempotence (section idempotence,
    // voir src/core/memory.js claimIdempotencyEvent). Un evenement claim
    // mais jamais confirme (crash, timeout) redevient reclamable apres ce
    // delai - "reprise raisonnable" plutot qu'un blocage definitif. 10 min
    // par defaut : assez long pour laisser un traitement normal se
    // terminer, assez court pour ne pas geler un retry legitime.
    idempotencyTtlMs: int(process.env.IDEMPOTENCY_TTL_MS, 10 * 60 * 1000),
  },

  http: {
    maxBodyBytes: int(process.env.MAX_HTTP_BODY_BYTES, 1024 * 1024),
    allowedOrigin: process.env.ALLOWED_ORIGIN || '',
  },

  webhook: {
    secret: process.env.CONQUISTADOR_WEBHOOK_SECRET || '',
    required: bool(process.env.REQUIRE_WEBHOOK_SIGNATURE, isProduction),
  },

  meta: {
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || '',
    configurationId: process.env.META_CONFIGURATION_ID || '',
    redirectUri: process.env.META_OAUTH_REDIRECT_URI || '',
    tokenEncryptionKey: process.env.META_TOKEN_ENCRYPTION_KEY || '',
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
    graphApiVersion: process.env.META_GRAPH_API_VERSION || 'v26.0',
    oauthScope:
      process.env.META_OAUTH_SCOPE ||
      [
        'pages_show_list',
        'pages_read_engagement',
        'pages_read_user_content',
        'pages_manage_engagement',
        'pages_manage_posts',
        'pages_manage_metadata',
        'pages_messaging',
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_content_publish',
      ].join(','),
  },

  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID || '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
    redirectUri: process.env.YOUTUBE_OAUTH_REDIRECT_URI || '',
    tokenEncryptionKey: process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY || '',
    oauthScope:
      process.env.YOUTUBE_OAUTH_SCOPE ||
      'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload',
  },

  tiktok: {
    clientKey: process.env.TIKTOK_CLIENT_KEY || '',
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
    redirectUri: process.env.TIKTOK_OAUTH_REDIRECT_URI || '',
    tokenEncryptionKey: process.env.TIKTOK_TOKEN_ENCRYPTION_KEY || '',
    oauthScope:
      process.env.TIKTOK_OAUTH_SCOPE ||
      'user.info.basic,video.list,video.publish',
  },

  // BUG CORRIGE (audit V7) : src/core/chariow.js lisait config.chariow.apiKey
  // mais cette section n'existait nulle part dans config.js - le connecteur
  // Chariow etait donc TOUJOURS "non configure" en production, meme avec
  // CHARIOW_API_KEY correctement definie dans Netlify. Ajout purement additif.
  chariow: {
    apiKey: process.env.CHARIOW_API_KEY || '',
    storeId: process.env.CHARIOW_STORE_ID || '',
    baseUrl: process.env.CHARIOW_BASE_URL || 'https://api.chariow.com/v1',
  },
  brand: {
    name: process.env.BRAND_NAME || 'Savoir Utile',
    productName:
      process.env.PRODUCT_NAME ||
      "La methode complete pour trouver un emploi en Afrique francophone",
    productUrl:
      process.env.PRODUCT_URL || 'https://savoir-utile.mychariow.shop/prd_s33t0e',
    shopUrl: process.env.SHOP_URL || 'https://savoir-utile.mychariow.shop',
    voiceProvider: process.env.VOICE_PROVIDER || 'Rémy Neural via edge-tts',
    voiceName: process.env.VOICE_NAME || 'Rémy Neural',
    voiceApiUrl: process.env.VOICE_STUDIO_API_URL || '',
    characters: ['Samuel', 'Marc'],
    // VISUAL_CONTINUITY_POLICY (section 12-14 du prompt maitre V1.1) : ces
    // identifiants doivent pointer vers les references visuelles OFFICIELLES
    // reellement presentes dans la base de connaissances du projet
    // (CONQUISTADOR_OS/04_PERSONNAGES, CONQUISTADOR_OS/03_LOGOS). Les
    // references officielles fournies par Savoir Utile sont deja bundlees
    // dans ce projet (voir assets/README.md) et .env.example pointe deja
    // vers elles par defaut. Si aucune variable d'environnement n'est
    // definie (ex: tests unitaires isoles), ces identifiants restent null
    // par honnetete plutot que de supposer une valeur.
    characterRefs: {
      Samuel: process.env.CHARACTER_REF_SAMUEL || null,
      Marc: process.env.CHARACTER_REF_MARC || null,
    },
    logo: {
      assetId: process.env.LOGO_ASSET_ID || null,
      description: 'Logo officiel Savoir Utile (asset immuable, jamais regenere par IA) - voir assets/logo/',
    },
    // Descriptions textuelles completes des personnages officiels (derivees
    // de assets/personnages/bible-personnages-samuel-marc.jpg), injectees
    // dans les prompts IA de generation de contenu (voir src/agents/base.js)
    // pour que les scenes/prompts d'image produits restent fideles aux
    // references memes lorsque le fournisseur IA texte ne "voit" pas
    // directement le fichier image.
    characterBible: {
      Samuel:
        "Samuel, 22-24 ans, africain francophone, chercheur d'emploi ambitieux. " +
        'Visage jeune sympathique et expressif, yeux marron fonce, cheveux noirs ' +
        'courts coiffure moderne, peau noire traits africains authentiques, corps ' +
        'athletique moyen, posture droite. Tenue : chemise bleue claire manches ' +
        'retroussees, jean bleu fonce, chaussures en cuir marron, sac a dos ' +
        'pratique. Style simple, propre, accessible. Personnalite : determine, ' +
        'intelligent, curieux, humble, parfois stresse ou decourage mais toujours ' +
        "pret a apprendre. Represente le public cible de Savoir Utile.",
      Marc:
        'Marc, 35-45 ans, africain francophone, recruteur experimente et mentor. ' +
        'Visage mature rassurant et professionnel, yeux marron fonce, cheveux ' +
        'noirs courts, barbe bien entretenue, peau noire traits africains ' +
        'authentiques, corps athletique moyen, posture confiante. Tenue : costume ' +
        'bleu marine elegant, chemise bleue claire, ceinture et chaussures en ' +
        'cuir marron, montre classique. Style professionnel et credible. ' +
        'Personnalite : calme, patient, pedagogue, honnete, bienveillant, ' +
        'autoritaire mais accessible. Guide Samuel dans sa progression.',
    },
    whatsapp: {
      type: 'chaine',
      name: 'Chaine WhatsApp Savoir Utile',
      hasApiAccess: false,
    },
  },

  approval: {
    override: (() => {
      try {
        return process.env.APPROVAL_POLICY_OVERRIDE
          ? JSON.parse(process.env.APPROVAL_POLICY_OVERRIDE)
          : {};
      } catch (err) {
        return {};
      }
    })(),
  },

  rateLimitPerMinute: int(process.env.RATE_LIMIT_PER_MINUTE, 30),
  isProduction,
};

module.exports = { config, bool, int };
