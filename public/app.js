'use strict';

/* ==========================================================================
   CONQUISTADOR OS — logique du tableau de bord
   Aucune donnee n'est inventee : tout ce qui est affiche provient des
   endpoints /api/* qui lisent la memoire persistante reelle du systeme.
   ========================================================================== */

const API = '/api';
const KEY_STORAGE = 'conquistador_api_key';
const AI_ORDER = ['gemini', 'groq', 'openrouter', 'mock'];
const AI_LABELS = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter', mock: 'Mock' };
const onboardingState = { step: 1, health: null, connectors: [] };
const objectivesState = { objectifs: null, progres: null };
const periodState = { granularite: 'semaine', offset: 0 };
const VIEWS = ['vue-generale', 'contenu', 'videos', 'reseaux-sociaux', 'prospects', 'commercial', 'statistiques', 'objectifs', 'ia', 'systeme', 'parametres'];
const VIEW_LABELS = {
  'vue-generale': 'Vue générale', contenu: 'Contenu', videos: 'Vidéos', 'reseaux-sociaux': 'Réseaux sociaux',
  prospects: 'Prospects', commercial: 'Commercial', statistiques: 'Statistiques', objectifs: 'Objectifs',
  ia: 'IA', systeme: 'Système', parametres: 'Paramètres',
};
const dashboardState = { last: null };

/* ============================ MODALE PREMIUM (remplace confirm()/alert()) */
function showConfirmModal({ eyebrow = 'Confirmation', title, bodyHtml, confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    document.getElementById('modalEyebrow').textContent = eyebrow;
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    const confirmBtn = document.getElementById('modalConfirmBtn');
    const cancelBtn = document.getElementById('modalCancelBtn');
    confirmBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    confirmBtn.className = danger ? 'modal-btn-confirm danger' : 'modal-btn-confirm';
    const cleanup = (result) => {
      overlay.classList.remove('open');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = (e) => { if (e.target === overlay) cleanup(false); };
    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(false); };
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);
    overlay.classList.add('open');
    confirmBtn.focus();
  });
}

/* ============================ ROUTEUR DE VUES (11 espaces) =============== */
function setActiveView(view, { pushHash = true } = {}) {
  const target = VIEWS.includes(view) ? view : 'vue-generale';
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('view-active', el.dataset.view === target);
  });
  document.querySelectorAll('.nav-item[data-nav]').forEach((btn) => {
    const active = btn.dataset.nav === target;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (pushHash) window.history.replaceState(null, '', `#${target}`);
  closeSidebarMobile();
  const contentEl = document.querySelector('.view-content');
  if (contentEl) contentEl.scrollTop = 0;
}

function initViewRouter() {
  document.querySelectorAll('.nav-item[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => setActiveView(btn.dataset.nav));
  });
  const initial = (window.location.hash || '').replace('#', '');
  setActiveView(VIEWS.includes(initial) ? initial : 'vue-generale', { pushHash: false });
  window.addEventListener('hashchange', () => {
    const v = (window.location.hash || '').replace('#', '');
    if (VIEWS.includes(v)) setActiveView(v, { pushHash: false });
  });
}

function openSidebarMobile() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('scrim').classList.add('open');
  document.getElementById('sidebarToggleBtn').setAttribute('aria-expanded', 'true');
}
function closeSidebarMobile() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('scrim').classList.remove('open');
  document.getElementById('sidebarToggleBtn')?.setAttribute('aria-expanded', 'false');
}

/* ============================ NOTIFICATIONS (donnees reelles uniquement) = */
function computeNotifications(data) {
  const notifs = [];
  if (!data) return notifs;
  const approvals = data.approbations_en_attente || [];
  if (approvals.length) {
    notifs.push({ level: 'alerte', view: 'vue-generale', titre: `${approvals.length} approbation(s) en attente`, detail: 'Des actions attendent votre validation.' });
  }
  const errors = data.erreurs || [];
  if (errors.length) {
    notifs.push({ level: 'alerte', view: 'systeme', titre: `${errors.length} erreur(s) récente(s)`, detail: 'Consultez le journal des erreurs dans Système.' });
  }
  const connectors = onboardingState.connectors || [];
  (connectors || []).forEach((c) => {
    if (c && c.connecte === false) {
      notifs.push({ level: 'info', view: 'reseaux-sociaux', titre: `${c.plateforme || 'Connecteur'} non connecté`, detail: c.raison || 'Connexion à réaliser dans Réseaux sociaux.' });
    }
  });
  if (data.chariow && data.chariow.configure === false) {
    notifs.push({ level: 'info', view: 'commercial', titre: 'Chariow non configuré', detail: 'Ajoutez CHARIOW_API_KEY côté serveur pour activer les ventes.' });
  }
  if (data.modes && data.modes.mode === 'conquistador' && data.modes.autonomy_active) {
    notifs.push({ level: 'info', view: 'parametres', titre: 'Autonomie de campagne active', detail: 'Les publications de campagne peuvent s’exécuter sans validation humaine.' });
  }
  return notifs;
}

function renderNotifications(notifs) {
  const badge = document.getElementById('notifBadge');
  if (badge) badge.hidden = notifs.length === 0;
  const dotsByView = { videos: false, 'reseaux-sociaux': false, ia: false, systeme: false, parametres: false };
  notifs.forEach((n) => { if (n.view in dotsByView) dotsByView[n.view] = true; });
  Object.entries(dotsByView).forEach(([view, on]) => {
    const map = { videos: 'navDotVideos', 'reseaux-sociaux': 'navDotSocial', ia: 'navDotIa', systeme: 'navDotSysteme', parametres: 'navDotParametres' };
    const el = document.getElementById(map[view]);
    if (el) el.hidden = !on;
  });
  const list = document.getElementById('notifList');
  if (!list) return;
  if (!notifs.length) {
    list.innerHTML = '<div class="notif-empty">Rien à signaler pour le moment.</div>';
    return;
  }
  list.innerHTML = notifs.map((n) => `
    <div class="notif-item level-${n.level}" data-nav-target="${n.view}">
      <span class="notif-dot"></span>
      <div class="notif-item-body"><strong>${escapeHtml(n.titre)}</strong><span>${escapeHtml(n.detail)}</span></div>
    </div>`).join('');
  list.querySelectorAll('[data-nav-target]').forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { setActiveView(el.dataset.navTarget); toggleNotifPanel(false); });
  });
}

function toggleNotifPanel(force) {
  const panel = document.getElementById('notifPanel');
  const scrim = document.getElementById('scrim');
  const open = force !== undefined ? force : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  scrim.classList.toggle('open', open);
}

/* ============================ RECHERCHE GLOBALE =========================== */
const SEARCH_INDEX = [
  { label: 'Vue générale', view: 'vue-generale', kw: 'accueil dashboard etat systeme' },
  { label: 'Contenu — Lancer une tâche', view: 'contenu', kw: 'creation script idee calendrier' },
  { label: 'Base de connaissances', view: 'contenu', kw: 'guide reference document image' },
  { label: 'Pipeline vidéo contrôlé', view: 'videos', kw: 'video creation qualite' },
  { label: 'Contrôle qualité et revues vidéo', view: 'videos', kw: 'qualite conformite validation score' },
  { label: 'Connecteurs sociaux (Meta, YouTube, TikTok)', view: 'reseaux-sociaux', kw: 'facebook instagram youtube tiktok meta oauth' },
  { label: 'Prospects récents', view: 'prospects', kw: 'crm contact lead' },
  { label: 'Agent commercial', view: 'commercial', kw: 'vente chariow ca prospect conversion' },
  { label: 'Statistiques', view: 'statistiques', kw: 'graphique vues abonnes courbe' },
  { label: 'Objectifs de la semaine', view: 'objectifs', kw: 'objectif ca ventes progression pourcentage' },
  { label: 'Fournisseurs IA', view: 'ia', kw: 'gemini groq openrouter modele' },
  { label: 'Studio vocal Rémy Neural', view: 'ia', kw: 'voix off audio tts' },
  { label: 'État système', view: 'systeme', kw: 'sante backend memoire' },
  { label: 'Kill switch', view: 'systeme', kw: 'securite arret urgence mode securise' },
  { label: 'Tâches récentes', view: 'systeme', kw: 'agent execution journal' },
  { label: 'Erreurs récentes', view: 'systeme', kw: 'erreur bug incident' },
  { label: 'Rapport quotidien', view: 'systeme', kw: 'rapport resume' },
  { label: 'Modes et paramètres opérationnels', view: 'parametres', kw: 'silencio copilot conquistador campagne quota horaire fuseau' },
];

function openSearch() {
  const overlay = document.getElementById('searchOverlay');
  overlay.classList.add('open');
  document.getElementById('searchInput').value = '';
  document.getElementById('searchInput').focus();
  renderSearchResults(SEARCH_INDEX);
}
function closeSearch() { document.getElementById('searchOverlay').classList.remove('open'); }
function renderSearchResults(results) {
  const el = document.getElementById('searchResults');
  if (!results.length) { el.innerHTML = '<div class="notif-empty">Aucun résultat.</div>'; return; }
  el.innerHTML = results.map((r, i) => `<div class="search-result${i === 0 ? ' hi' : ''}" data-view="${r.view}"><span>${escapeHtml(r.label)}</span><span class="sr-view">${escapeHtml(VIEW_LABELS[r.view] || r.view)}</span></div>`).join('');
  el.querySelectorAll('.search-result').forEach((node) => {
    node.addEventListener('click', () => { setActiveView(node.dataset.view); closeSearch(); });
  });
}
function initSearch() {
  document.getElementById('searchTriggerBtn').addEventListener('click', openSearch);
  document.getElementById('searchOverlay').addEventListener('click', (e) => { if (e.target.id === 'searchOverlay') closeSearch(); });
  document.getElementById('searchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { renderSearchResults(SEARCH_INDEX); return; }
    renderSearchResults(SEARCH_INDEX.filter((r) => (r.label + ' ' + r.kw).toLowerCase().includes(q)));
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
    else if (e.key === 'Escape') closeSearch();
  });
}

/* ============================ VUE GENERALE (cartes de synthese) =========== */
const MODE_DESCRIPTIONS = {
  silencio: 'Calme et sécurisé — aucune action externe automatique.',
  copilot: 'Le système analyse, prépare et propose ; les actions importantes attendent votre validation.',
  conquistador: 'Autonomie encadrée par vos règles (plateformes, horaires, quotas, score qualité) — le kill switch garde toujours la priorité.',
};
function renderOverview(data) {
  if (!data) return;
  const mode = data.modes?.mode || 'silencio';
  applyConfirmedMode(mode, { policy: data.modes?.mode_policy });
  document.getElementById('ovApprobations').textContent = (data.approbations_en_attente || []).length;
  document.getElementById('ovTaches').textContent = (data.taches || []).length;
  document.getElementById('ovErreurs').textContent = (data.erreurs || []).length;
  document.getElementById('ovProspects').textContent = (data.prospects || []).length;
  const ventes = data.progres_hebdomadaire?.progres?.ventes;
  document.getElementById('ovVentes').textContent = ventes ? `${formatNumber(ventes.actuel)}` : '—';
  const ca = data.progres_hebdomadaire?.progres?.chiffre_affaires;
  document.getElementById('ovObjectifCa').textContent = ca && ca.objectif > 0 ? `${formatNumber(ca.actuel)} / ${formatNumber(ca.objectif)}` : (ca ? formatNumber(ca.actuel) : '—');
}

function renderCommercialSummary(resume) {
  const el = document.getElementById('commercialSummaryGrid');
  if (!el) return;
  if (!resume) { el.innerHTML = emptyRow('Résumé commercial indisponible.'); return; }
  const parStade = resume.par_stade || {};
  el.innerHTML = `
    <div class="overview-card"><span class="ov-label">Total prospects</span><span class="ov-value">${formatNumber(resume.nombre_total_prospects || 0)}</span></div>
    <div class="overview-card accent"><span class="ov-label">Clients (convertis)</span><span class="ov-value">${formatNumber(resume.conversions || 0)}</span></div>
    <div class="overview-card"><span class="ov-label">Demandes du guide</span><span class="ov-value">${formatNumber(resume.demandes_guide || 0)}</span></div>
    <div class="overview-card"><span class="ov-label">Relances en attente</span><span class="ov-value">${formatNumber(resume.relances_en_attente || 0)}</span></div>
    <div class="overview-card"><span class="ov-label">Nouveaux</span><span class="ov-value">${formatNumber(parStade.nouveau || 0)}</span></div>
    <div class="overview-card"><span class="ov-label">Chauds</span><span class="ov-value">${formatNumber(parStade.chaud || 0)}</span></div>`;
}

function renderChariowStatus(chariow) {
  const el = document.getElementById('chariowStatusPanel');
  if (!el) return;
  if (!chariow) { el.innerHTML = emptyRow('Statut Chariow indisponible.'); return; }
  if (!chariow.configure) {
    el.innerHTML = '<div class="empty">Chariow non configuré côté serveur — définissez CHARIOW_API_KEY dans Netlify pour activer le suivi des ventes.</div>';
    return;
  }
  el.innerHTML = `<div class="entry"><div class="entry-stamp">Chariow</div><div class="entry-body"><h3>Chariow <span class="tag ${chariow.connecte ? 'done' : 'pending'}">${chariow.connecte ? 'connecté' : 'clé invalide ou API inaccessible'}</span></h3>${chariow.raison ? `<p>${escapeHtml(chariow.raison)}</p>` : ''}</div></div>`;
}

function renderContentRanking(classement) {
  const el = document.getElementById('contentRankingList');
  if (!el) return;
  const rows = classement?.classement || [];
  if (!rows.length) { el.innerHTML = emptyRow(classement?.lecture || 'Aucun contenu avec identifiant (content_key) enregistré sur cette période.'); return; }
  el.innerHTML = rows.map((r, i) => `
    <div class="entry">
      <div class="entry-stamp">#${i + 1}</div>
      <div class="entry-body">
        <h3>${escapeHtml(r.content_key)} ${r.plateforme ? `<span class="tag">${escapeHtml(r.plateforme)}</span>` : ''}</h3>
        <p>Vues : ${formatNumber(r.vues || 0)} · Engagement : ${formatNumber(r.score_engagement || 0)} · Taux : ${r.taux_engagement !== null ? `${(r.taux_engagement * 100).toFixed(1)}%` : '—'}</p>
      </div>
    </div>`).join('') + (classement.lecture ? `<p class="chart-note">${escapeHtml(classement.lecture)}</p>` : '');
}

function populateTimezoneOptions(list) {
  const datalist = document.getElementById('tzList');
  if (!datalist || !Array.isArray(list) || !list.length) return;
  datalist.innerHTML = list.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.pays)} — ${escapeHtml(c.ville)} (${escapeHtml(c.utc_actuel || '')})</option>`).join('');
}

const TASK_TYPES = [
  'content.idea', 'content.script', 'content.scenes', 'content.full_video', 'content.calendar', 'content.prepare_post', 'content.adapt_platforms',
  'commercial.analyze_intent', 'commercial.prepare_response', 'commercial.analyze_conversion', 'commercial.detect_comment_intent', 'commercial.prepare_followup',
  'client.upsert_contact', 'client.answer_question',
  'analysis.performance', 'analysis.opportunity',
  'stats.record', 'stats.summary',
  'affiliation.register', 'affiliation.followup', 'affiliation.report',
  'research.topic',
  'quality.review', 'video.review', 'pipeline.video',
  'directeur.priorities',
  'system.send_message', 'system.publish_post', 'system.update_data',
];

function apiKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const key = apiKey();
  if (key) headers['x-conquistador-key'] = key;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.erreur || `Erreur HTTP ${res.status}`);
  }
  return body;
}

function fmtTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function emptyRow(msg) {
  return `<div class="empty">${escapeHtml(msg)}</div>`;
}

/* --- Onboarding et statut general ----------------------------------------*/

function connectorByPlatform(platform) {
  return onboardingState.connectors.find((item) => item.plateforme === platform) || null;
}

function connectorLabel(platform) {
  const record = connectorByPlatform(platform);
  if (!record) return 'NON CONNECTE — verification indisponible';
  return record.connecte ? 'CONNECTE — statut confirme par le backend' : 'NON CONNECTE — aucune connexion fictive';
}

function renderOnboarding() {
  const h = onboardingState.health;
  const memory = document.getElementById('onboardingSupabaseStatus');
  const ai = document.getElementById('onboardingAiStatus');
  const meta = document.getElementById('onboardingMetaStatus');
  const tiktok = document.getElementById('onboardingTikTokStatus');
  const whatsapp = document.getElementById('onboardingWhatsappStatus');
  const youtube = document.getElementById('onboardingYoutubeStatus');
  if (memory) memory.textContent = h ? `Backend memoire actuel : ${h.memoire_backend}. ${h.memoire_backend === 'supabase' ? 'Persistance serveur active.' : 'Fallback JSON local : configurez Supabase avant la production.'}` : 'Verification en cours...';
  if (ai) {
    const active = h && h.fournisseurs_ia ? AI_ORDER.filter((id) => id === 'mock' || h.fournisseurs_ia[id]).map((id) => AI_LABELS[id]) : AI_ORDER.map((id) => AI_LABELS[id]);
    ai.textContent = `Ordre canonique : ${AI_ORDER.map((id) => AI_LABELS[id]).join(' → ')}. Fournisseurs configurés : ${active.join(', ')}.`;
  }
  if (meta) meta.textContent = `Facebook : ${connectorLabel('facebook')} · Instagram : ${connectorLabel('instagram')}`;
  if (tiktok) tiktok.textContent = connectorLabel('tiktok');
  if (whatsapp) whatsapp.textContent = connectorLabel('whatsapp');
  if (youtube) youtube.textContent = connectorLabel('youtube');
}

function setOnboardingStep(step) {
  const maxSteps = 6;
  onboardingState.step = Math.max(1, Math.min(maxSteps, Number(step) || 1));
  document.querySelectorAll('[data-onboarding-step]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.onboardingStep) === onboardingState.step);
  });
  document.querySelectorAll('[data-onboarding-panel]').forEach((panel) => {
    const active = Number(panel.dataset.onboardingPanel) === onboardingState.step;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  const label = document.getElementById('onboardingProgressLabel');
  const bar = document.getElementById('onboardingProgressBar');
  const summary = document.getElementById('onboardingStepSummary');
  const summaries = ['Connexion et memoire', 'Fournisseurs IA', 'Facebook / Instagram', 'TikTok', 'WhatsApp', 'YouTube'];
  if (label) label.textContent = `Etape ${onboardingState.step} sur ${maxSteps}`;
  if (summary) summary.textContent = summaries[onboardingState.step - 1];
  if (bar) bar.style.width = `${(onboardingState.step / maxSteps) * 100}%`;
  const prev = document.getElementById('onboardingPrevBtn');
  const next = document.getElementById('onboardingNextBtn');
  if (prev) prev.disabled = onboardingState.step === 1;
  if (next) next.textContent = onboardingState.step === maxSteps ? 'Terminer' : 'Suivante';
}

async function checkOnboarding(kind) {
  if (kind === 'connectors') await loadConnectors();
  else await loadHealth();
  renderOnboarding();
}

/* --- Statut general ------------------------------------------------------*/

async function loadHealth() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  try {
    const h = await api('/health');
    onboardingState.health = h;
    dot.className = 'dot ok';
    const order = Array.isArray(h.fournisseurs_ia && h.fournisseurs_ia.ordre) ? h.fournisseurs_ia.ordre : AI_ORDER;
    text.textContent = `operationnel · IA: ${order.map((id) => AI_LABELS[id] || id).join(' → ')} · memoire: ${h.memoire_backend}`;
    document.getElementById('backendLabel').textContent = `memoire: ${h.memoire_backend}`;
    renderOnboarding();
  } catch (err) {
    dot.className = 'dot bad';
    text.textContent = `hors ligne (${err.message})`;
    renderOnboarding();
  }
}

/* --- Approbations ---------------------------------------------------------*/

async function loadApprovals() {
  const el = document.getElementById('approvalsList');
  try {
    const { approbations } = await api('/approvals');
    if (!approbations.length) {
      el.innerHTML = emptyRow('Aucune action en attente de validation.');
      return;
    }
    el.innerHTML = approbations.map((a) => `
      <div class="entry">
        <div class="entry-stamp">${fmtTime(a.created_at)}</div>
        <div class="entry-body">
          <h3>${escapeHtml(a.data.actionType)} <span class="tag pending">en attente</span></h3>
          <p>${escapeHtml(a.data.summary || '')}</p>
        </div>
        <div class="entry-actions">
          <button class="approve" data-id="${a.id}" data-approve="true">Approuver</button>
          <button class="reject" data-id="${a.id}" data-approve="false">Rejeter</button>
        </div>
      </div>
    `).join('');
    el.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', () => decideApproval(btn.dataset.id, btn.dataset.approve === 'true'));
    });
  } catch (err) {
    el.innerHTML = emptyRow(`Erreur de chargement : ${err.message}`);
  }
}

async function decideApproval(id, approve) {
  try {
    await api('/approvals/' + id, { method: 'POST', body: JSON.stringify({ id, approve }) });
    await Promise.all([loadApprovals(), loadTasks(), loadDashboard()]);
  } catch (err) {
    alert(`Impossible de traiter cette approbation : ${err.message}`);
  }
}

/* --- Taches ---------------------------------------------------------------*/

function populateTaskTypes() {
  const select = document.getElementById('taskType');
  select.innerHTML = TASK_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('');
}

function renderTaskStatus(status) {
  return `<span class="tag ${status}">${status.replace(/_/g, ' ')}</span>`;
}

function actionState(data) {
  const output = data && data.result && data.result.output;
  const externalStatus = output && output.statut;
  if (data && data.status === 'waiting_approval') return { label: 'validation requise', className: 'pending' };
  if (['ENVOYE', 'PUBLIE', 'MIS_A_JOUR'].includes(externalStatus)) return { label: 'action exécutée', className: 'executed' };
  if (externalStatus === 'NON_EXECUTE_AUCUNE_CONNEXION' || externalStatus === 'ACTION_PREPAREE') return { label: 'action préparée', className: 'prepared' };
  if (data && data.status === 'done') return { label: 'workflow terminé', className: 'done' };
  return { label: 'en cours', className: 'pending' };
}

async function loadTasks() {
  const el = document.getElementById('tasksList');
  try {
    const { taches } = await api('/tasks?limit=20');
    if (!taches.length) {
      el.innerHTML = emptyRow('Aucune tache pour le moment. Lancez-en une ci-dessus.');
      return;
    }
    el.innerHTML = taches.map((t) => `
      <div class="entry">
        <div class="entry-stamp">${fmtTime(t.created_at)}</div>
        <div class="entry-body">
          <h3>${escapeHtml(t.data.type)} ${renderTaskStatus(t.data.status)} <span class="tag ${actionState(t.data).className}">${actionState(t.data).label}</span></h3>
          <p>${escapeHtml(t.data.error ? 'Erreur : ' + t.data.error : summarizeResult(t.data.result))}</p>
        </div>
        <div class="entry-actions"></div>
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = emptyRow(`Erreur de chargement : ${err.message}`);
  }
}

function summarizeResult(result) {
  if (!result) return 'Resultat non disponible pour le moment.';
  try {
    const s = JSON.stringify(result);
    return s.length > 280 ? s.slice(0, 280) + '...' : s;
  } catch (err) {
    return 'Resultat non serialisable.';
  }
}

async function launchTask() {
  const msg = document.getElementById('taskFormMsg');
  msg.className = 'form-msg';
  msg.textContent = 'Execution en cours...';
  try {
    const type = document.getElementById('taskType').value;
    const priority = document.getElementById('taskPriority').value;
    let input = {};
    const raw = document.getElementById('taskInput').value.trim();
    if (raw) input = JSON.parse(raw);
    const { tache } = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ type, priority, input, executeNow: true }),
    });
    msg.className = 'form-msg ok';
    msg.textContent = `Tache ${tache.data.status} (id: ${tache.id.slice(0, 8)}...)`;
    await Promise.all([loadTasks(), loadApprovals(), loadDashboard()]);
  } catch (err) {
    msg.className = 'form-msg error';
    msg.textContent = `Erreur : ${err.message}`;
  }
}

/* --- Pipeline vidéo guidé ---------------------------------------------------*/

function renderVideoPipelineResult(output) {
  const el = document.getElementById('videoPipelineResult');
  if (!el) return;
  if (!output || typeof output !== 'object') {
    el.innerHTML = emptyRow('Résultat du pipeline non disponible.');
    return;
  }
  const revueVideo = output.revue_video || {};
  const revueEditoriale = output.revue_editoriale || {};
  const list = (items, fallback) => Array.isArray(items) && items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : `<p class="pipeline-ok">${escapeHtml(fallback)}</p>`;
  const revisions = Array.isArray(output.revisions) ? output.revisions : [];
  const corrections = revueVideo.corrections_demandees || [];
  const howToCorrect = revueVideo.comment_corriger || [];
  const preserve = revueVideo.elements_a_preserver || [];
  const tone = output.conforme === true ? 'pipeline-result-ready' : 'pipeline-result-blocked';
  el.innerHTML = `
    <div class="pipeline-result ${tone}">
      <div class="pipeline-result-head">
        <strong>${escapeHtml(output.statut || 'État inconnu')}</strong>
        <span>${output.provider ? `IA créative : ${escapeHtml(output.provider)}` : 'IA créative : non utilisée'}</span>
      </div>
      <p class="pipeline-result-note">${escapeHtml(output.note || 'Le pipeline ne publie pas directement.')}</p>
      <div class="pipeline-result-grid">
        <div><h4>Revue éditoriale</h4>${list(revueEditoriale.problemes, 'Aucun problème éditorial détecté.')}</div>
        <div><h4>Problèmes identifiés</h4>${list(revueVideo.problemes_identifies || revueVideo.problemes, 'Aucun problème bloquant détecté.')}</div>
        <div><h4>Corrections demandées</h4>${list(corrections, 'Aucune correction structurée.')}</div>
        <div><h4>Comment corriger</h4>${list(howToCorrect, 'Aucune méthode complémentaire.')}</div>
        <div><h4>Éléments à préserver</h4>${list(preserve, 'Aucun élément déjà validé listé.')}</div>
        <div><h4>Preuves / timeline</h4>${list(revueVideo.preuves_manquantes, revueVideo.timeline_synchronisee === true ? 'Timeline voix-images-sous-titres conforme au manifeste.' : 'Timeline de synchronisation non validée.')}</div>
        <div><h4>Corrections transmises</h4><p>${revisions.length ? `${revisions.length} cycle(s) borné(s) transmis à l’agent créatif.` : 'Aucun cycle de correction transmis.'}</p></div>
      </div>
      <p class="pipeline-result-final"><strong>Publication :</strong> jamais autorisée automatiquement. ${output.conforme === true ? 'Approbation humaine encore requise.' : 'Corriger les éléments bloquants et fournir une preuve vidéo durable.'}</p>
    </div>`;
}

async function launchVideoPipeline() {
  const msg = document.getElementById('videoPipelineMsg');
  const subject = document.getElementById('videoPipelineSubject')?.value.trim() || '';
  const sourceUrl = document.getElementById('videoPipelineUrl')?.value.trim() || '';
  const rawManifest = document.getElementById('videoPipelineManifest')?.value.trim() || '';
  const autoRevise = document.getElementById('videoPipelineAutoRevise')?.checked !== false;
  if (msg) {
    msg.className = 'form-msg';
    msg.textContent = 'Préparation du pipeline créatif et contrôle vidéo...';
  }
  try {
    let manifest = {};
    if (rawManifest) {
      try {
        manifest = JSON.parse(rawManifest);
      } catch (err) {
        throw new Error('Le manifeste vidéo doit être un JSON valide.');
      }
    }
    const input = {
      sujet: subject || 'Conseil éducatif aligné avec Savoir Utile',
      auto_revise: autoRevise,
      max_revisions: 2,
      use_ai_quality: true,
      use_media_ai: true,
      video: { ...manifest, ...(sourceUrl ? { source_url: sourceUrl } : {}) },
    };
    const { tache } = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ type: 'pipeline.video', priority: 'normale', input, executeNow: true }),
    });
    const output = tache?.data?.result?.output;
    const status = output?.statut || tache?.data?.status || 'inconnu';
    renderVideoPipelineResult(output);
    if (msg) {
      msg.className = `form-msg${status === 'PRET_POUR_APPROBATION' ? ' ok' : ' error'}`;
      msg.textContent = `Pipeline ${status}. Une vidéo non inspectée reste bloquée avant publication.`;
    }
    await Promise.all([loadTasks(), loadApprovals(), loadDashboard()]);
  } catch (err) {
    if (msg) {
      msg.className = 'form-msg error';
      msg.textContent = `Pipeline impossible : ${err.message}`;
    }
  }
}

const VIDEO_JOB_STATUS_LABELS = {
  QUEUED: 'En file', PREPARING: 'Préparation (script/scènes)', GENERATING_SCRIPT: 'Génération du script',
  PREPARING_REFERENCES: 'Résolution des références', GENERATING_ASSETS: 'Génération des visuels',
  GENERATING_VOICE: 'Génération de la voix', BUILDING_TIMELINE: 'Construction de la timeline',
  COMPOSING: 'Composition (sous-titres/audio)', RENDERING: 'Rendu FFmpeg',
  QUALITY_CHECK: 'Contrôle qualité', COMPLETED: 'Rendu terminé (stockage requis)',
  READY: 'Prêt à diffuser', SCHEDULED: 'Programmé', PUBLISHING: 'Publication en cours',
  PUBLISHED: 'Publié (confirmé)', FAILED: 'Échoué', CANCELLED: 'Annulé',
};

const VIDEO_JOB_TERMINAL = ['COMPLETED', 'PUBLISHED', 'FAILED', 'CANCELLED'];

function videoJobStatusTone(job) {
  if (job.status === 'PUBLISHED' || job.status === 'READY') return 'ok';
  if (job.status === 'FAILED') return 'error';
  if (job.status === 'PUBLISHING') return 'warn';
  return '';
}

function renderVideoJobs(jobs) {
  const el = document.getElementById('videoJobsList');
  if (!el) return;
  if (!jobs || jobs.length === 0) {
    el.innerHTML = '<div class="empty">Aucun job vidéo pour le moment.</div>';
    return;
  }
  el.innerHTML = jobs.map((job) => {
    const tone = videoJobStatusTone(job);
    const assetsNote = job.assets ? `Assets : ${job.assets.reussis}/${job.assets.total}` : '';
    const voiceNote = job.voice && job.voice.statut_voix ? `Voix : ${job.voice.statut_voix}` : '';
    const qcNote = job.quality_check ? `Contrôle qualité fichier : ${job.quality_check.ok ? 'conforme' : 'non conforme'}` : '';
    const storageNote = job.storage_ok === true && job.output_url ? 'Stockage durable : URL vérifiée' : (job.storage ? `Stockage : ${job.storage.raison || 'non configuré'}` : '');
    const reviewNote = job.quality_check && job.quality_check.needs_review
      ? `<p class="pipeline-result-note"><strong>À vérifier manuellement :</strong> ${escapeHtml(job.quality_check.review_reason || 'cohérence de personnage insuffisante')}</p>`
      : '';
    const pubNote = job.publication && job.publication.state
      ? `Diffusion : ${job.publication.state}${job.publication.external_post_id ? ` (post ${escapeHtml(job.publication.external_post_id)})` : ''}${job.publication.scheduled_for ? ` · prévu ${fmtTime(job.publication.scheduled_for)}` : ''}${job.publication.last_error ? ` · erreur : ${escapeHtml(job.publication.last_error)}` : ''}`
      : '';
    const errorNote = job.error ? `<p class="pipeline-result-note">Cause (${escapeHtml(job.error_step || '?')}) : ${escapeHtml(job.error)}</p>` : '';
    const playable = job.storage_ok === true && job.output_url && ['COMPLETED', 'READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED'].includes(job.status);
    const link = playable ? `<p class="pipeline-result-final"><a href="${escapeHtml(job.output_url)}" target="_blank" rel="noopener">Ouvrir le MP4</a></p>` : '';
    const canContinue = !VIDEO_JOB_TERMINAL.includes(job.status);
    return `
      <div class="entry-item pipeline-result ${tone}">
        <div class="pipeline-result-head">
          <strong>${escapeHtml(VIDEO_JOB_STATUS_LABELS[job.status] || job.status)}</strong>
          <span>${job.progress || 0}% · ${escapeHtml(String(job.id).slice(0, 8))} · ${fmtTime(job.created_at)}</span>
        </div>
        <p class="pipeline-result-note">${escapeHtml([assetsNote, voiceNote, qcNote, storageNote].filter(Boolean).join(' · ') || 'En cours...')}</p>
        ${reviewNote}
        ${pubNote ? `<p class="pipeline-result-note">${pubNote}</p>` : ''}
        ${errorNote}
        ${link}
        ${canContinue ? `<button class="station-action" data-job-process="${escapeHtml(job.id)}" type="button">Continuer le traitement</button>` : ''}
      </div>`;
  }).join('');
  el.querySelectorAll('[data-job-process]').forEach((btn) => btn.addEventListener('click', () => processVideoJob(btn.dataset.jobProcess)));
}

async function loadVideoJobs() {
  try {
    const { jobs } = await api('/video/jobs?limit=20');
    renderVideoJobs(jobs);
    return jobs;
  } catch (err) {
    const el = document.getElementById('videoJobsList');
    if (el) el.innerHTML = `<div class="empty">Chargement impossible : ${escapeHtml(err.message)}</div>`;
    return [];
  }
}

async function processVideoJob(id) {
  try {
    await api(`/video/jobs/${encodeURIComponent(id)}/process`, { method: 'POST' });
  } catch (err) {
    // L'etat reel (y compris une eventuelle erreur) sera de toute facon
    // reaffiche par le rafraichissement juste apres : pas besoin de dupliquer
    // le message ici.
  }
  await loadVideoJobs();
}

async function createVideoJob() {
  const msg = document.getElementById('videoJobMsg');
  const subject = document.getElementById('videoJobSubject')?.value.trim() || '';
  const useManifest = document.getElementById('videoJobUseManifest')?.checked === true;
  const rawManifest = document.getElementById('videoJobManifest')?.value.trim() || '';
  const formatValue = document.getElementById('videoJobFormat')?.value || '9:16';
  const targetDurationRaw = document.getElementById('videoJobTargetDuration')?.value.trim() || '';
  const targetDuration = Number(targetDurationRaw);
  const formatMap = {
    '9:16': { ratio: '9:16', width: 1080, height: 1920 },
    '16:9': { ratio: '16:9', width: 1920, height: 1080 },
    '1:1': { ratio: '1:1', width: 1080, height: 1080 },
    '4:5': { ratio: '4:5', width: 1080, height: 1350 },
  };
  if (msg) {
    msg.className = 'form-msg';
    msg.textContent = 'Génération en cours (script, visuels, voix, rendu, contrôle qualité réel)...';
  }
  try {
    const body = { format: formatMap[formatValue] || formatMap['9:16'] };
    if (Number.isFinite(targetDuration) && targetDuration > 0) {
      body.target_duration_seconds = targetDuration;
    }
    if (useManifest) {
      if (!rawManifest) throw new Error('Fournir un manifeste JSON, ou décocher la case pour partir d’un sujet.');
      try {
        body.manifest = JSON.parse(rawManifest);
      } catch (err) {
        throw new Error('Le manifeste fourni doit être un JSON valide.');
      }
    } else {
      if (!subject) throw new Error('Indiquer un sujet, ou fournir un manifeste JSON déjà prêt.');
      body.sujet = subject;
    }
    const { job } = await api('/video/jobs', { method: 'POST', body: JSON.stringify(body) });
    if (msg) {
      const ok = ['COMPLETED', 'READY', 'SCHEDULED', 'PUBLISHED'].includes(job.status);
      msg.className = `form-msg${ok ? ' ok' : ' error'}`;
      const delta = job.duration_proof && job.duration_proof.duration_delta_seconds != null
        ? ` Durée réelle : ${job.duration_proof.actual_duration_seconds}s pour une cible de ${job.duration_proof.target_duration_seconds}s (écart ${job.duration_proof.duration_delta_seconds > 0 ? '+' : ''}${job.duration_proof.duration_delta_seconds}s).`
        : '';
      msg.textContent = ok ? `Vidéo générée, contrôlée et stockée avec succès.${delta}` : `Job ${VIDEO_JOB_STATUS_LABELS[job.status] || job.status}${job.error ? ' — ' + job.error : ' — utilisez « Continuer le traitement » ci-dessous si le job n’est pas encore terminé.'}`;
    }
    await loadVideoJobs();
  } catch (err) {
    if (msg) {
      msg.className = 'form-msg error';
      msg.textContent = `Génération impossible : ${err.message}`;
    }
  }
}

/* --- Fournisseurs IA (AI PROVIDERS) ---------------------------------------*/

const PROVIDER_STATUS_LABEL = {
  ok: 'operationnel',
  erreur: 'en erreur',
  inconnu: 'pas encore appele',
};

async function loadProviders() {
  const el = document.getElementById('providersList');
  try {
    const { fournisseurs } = await api('/ai-providers');
    const ordered = [...fournisseurs].sort((a, b) => AI_ORDER.indexOf(a.id) - AI_ORDER.indexOf(b.id));
    el.innerHTML = ordered.map((f) => {
      const indispo = f.indisponible_temporairement;
      const statusTag = indispo
        ? '<span class="tag error">circuit ouvert / desactive</span>'
        : `<span class="tag ${f.statut === 'ok' ? 'done' : (f.statut === 'erreur' ? 'error' : 'pending')}">${escapeHtml(PROVIDER_STATUS_LABEL[f.statut] || f.statut)}</span>`;
      return `
      <div class="entry">
        <div class="entry-stamp">#${escapeHtml(String(f.id))}</div>
        <div class="entry-body">
          <h3>${escapeHtml(f.nom)} ${statusTag} ${f.configure ? '' : '<span class="tag pending">cle non configuree</span>'}</h3>
          <p>Modele : ${escapeHtml(f.modele)} · Quota : ${escapeHtml(f.quota)}<br/>
          Scores (1-5) — raisonnement ${f.scores.raisonnement} · vitesse ${f.scores.vitesse} · fiabilite ${f.scores.fiabilite} · contexte ${f.scores.contexte}<br/>
          ${f.dernier_appel ? `Dernier appel : ${fmtTime(f.dernier_appel)} (${f.appels_total} appel(s), ${f.erreurs_total} erreur(s), ${f.echecs_consecutifs} echec(s) consecutif(s))` : 'Jamais appele dans cette session'}
          ${f.circuit_ouvert_jusqua ? `<br/>Circuit ouvert jusqu'a ${fmtTime(f.circuit_ouvert_jusqua)}` : ''}
          ${f.desactive_manuellement ? `<br/>Desactive manuellement : ${escapeHtml(f.raison_desactivation || '')}` : ''}
          ${f.derniere_erreur ? `<br/>Derniere erreur : ${escapeHtml(f.derniere_erreur.message)}` : ''}</p>
        </div>
        <div class="entry-actions"></div>
      </div>
    `;
    }).join('');
  } catch (err) {
    el.innerHTML = emptyRow(`Erreur de chargement : ${err.message}`);
  }
}

/* --- Etat systeme / Diagnostic ---------------------------------------------*/

const DIAG_LABEL = { ok: 'OK', a_configurer: 'A configurer', erreur: 'Erreur' };
const DIAG_TAG_CLASS = { ok: 'done', a_configurer: 'pending', erreur: 'error' };

async function runDiagnostics() {
  const el = document.getElementById('diagnosticsList');
  el.innerHTML = emptyRow('Diagnostic en cours...');
  try {
    const result = await api('/diagnostics');
    el.innerHTML = result.verifications.map((v) => `
      <div class="entry">
        <div class="entry-stamp">${fmtTime(result.genere_le)}</div>
        <div class="entry-body">
          <h3>${escapeHtml(v.id.replace(/_/g, ' '))} <span class="tag ${DIAG_TAG_CLASS[v.statut]}">${DIAG_LABEL[v.statut]}</span></h3>
          <p>${escapeHtml(v.message)}</p>
        </div>
        <div class="entry-actions"></div>
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = emptyRow(`Erreur de chargement : ${err.message}`);
  }
}

/* --- Kill switch ------------------------------------------------------------*/

async function loadKillSwitch() {
  const dot = document.getElementById('killSwitchDot');
  const text = document.getElementById('killSwitchText');
  const btn = document.getElementById('killSwitchToggleBtn');
  try {
    const status = await api('/kill-switch');
    if (status.engage) {
      dot.className = 'dot bad';
      text.textContent = `MODE SECURISE ACTIF${status.raison ? ' — ' + status.raison : ''}`;
      btn.textContent = 'Desactiver le mode securise';
      btn.dataset.engage = 'false';
    } else {
      dot.className = 'dot ok';
      text.textContent = 'Actions externes autorisees (normal)';
      btn.textContent = 'Activer le mode securise';
      btn.dataset.engage = 'true';
    }
  } catch (err) {
    dot.className = 'dot bad';
    text.textContent = `Erreur : ${err.message}`;
  }
}

async function toggleKillSwitch() {
  const btn = document.getElementById('killSwitchToggleBtn');
  const wantsEngage = btn.dataset.engage === 'true';
  let confirmation = true;
  if (!wantsEngage) {
    confirmation = await showConfirmModal({
      eyebrow: 'Sécurité — kill switch',
      title: 'Réactiver les actions externes ?',
      bodyHtml: '<p class="modal-body">Cela désactive le mode sécurisé. Les envois/publications déjà approuvés pourront à nouveau s’exécuter.</p>',
      confirmLabel: 'Réactiver',
      danger: true,
    });
    if (!confirmation) return;
  } else {
    confirmation = await showConfirmModal({
      eyebrow: 'Sécurité — kill switch',
      title: 'Activer le mode sécurisé ?',
      bodyHtml: '<p class="modal-body">Aucune publication, message ou action externe ne pourra plus s’exécuter tant que vous ne le désactivez pas. Cette action a la priorité absolue sur tout le reste du système.</p>',
      confirmLabel: 'Activer le mode sécurisé',
      danger: true,
    });
    if (!confirmation) return;
  }
  try {
    await api('/kill-switch', {
      method: 'POST',
      body: JSON.stringify({ engage: wantsEngage, confirmation: true, raison: wantsEngage ? 'Active depuis le tableau de bord' : undefined }),
    });
    await loadKillSwitch();
  } catch (err) {
    alert(`Impossible de changer l'etat du mode securise : ${err.message}`);
  }
}

/* --- Connecteurs sociaux -----------------------------------------------------*/

/* Boutons "Connecter" : reutilisent EXCLUSIVEMENT les flux OAuth deja
   presents dans le projet (Meta couvre Facebook + Instagram, Google couvre
   YouTube, TikTok couvre TikTok). Aucun nouveau flux OAuth n'est cree ; une
   plateforme non connectee n'affiche le bouton que si son mecanisme de
   connexion existe deja. */
const CONNECTOR_OAUTH_FLOWS = {
  facebook: { start: () => startMetaOAuth(), fournisseur: 'Meta' },
  instagram: { start: () => startMetaOAuth(), fournisseur: 'Meta' },
  youtube: { start: () => startYoutubeOAuth(), fournisseur: 'Google' },
  tiktok: { start: () => startTiktokOAuth(), fournisseur: 'TikTok' },
};

async function startConnectorOAuth(plateforme, button) {
  const flow = CONNECTOR_OAUTH_FLOWS[plateforme];
  if (!flow) return;
  if (button) {
    button.disabled = true;
    button.textContent = 'Connexion\u2026';
  }
  try {
    // La fonction OAuth existante gere son feedback via son message d'action
    // (form-msg) et redirige vers le fournisseur en cas de succes. En cas
    // d'echec elle ne leve pas : elle affiche l'erreur. Le bouton est donc
    // toujours reactive proprement.
    await flow.start();
  } catch (err) {
    alert(`Connexion impossible pour "${plateforme}" : ${err.message}`);
  } finally {
    if (button && document.contains(button)) {
      button.disabled = false;
      button.textContent = 'Connecter';
    }
  }
}

async function loadConnectors() {
  const el = document.getElementById('connectorsList');
  try {
    const { connecteurs } = await api('/connectors');
    onboardingState.connectors = connecteurs;
    renderOnboarding();
    el.innerHTML = connecteurs.map((c) => `
      <div class="entry">
        <div class="entry-stamp connector-stamp">
          ${c.connecte && c.avatar ? `<img class="connector-avatar" data-avatar-img src="${escapeHtml(c.avatar)}" alt="" referrerpolicy="no-referrer" />` : ''}
          <span>${escapeHtml(c.plateforme)}</span>
        </div>
        <div class="entry-body">
          <h3>${escapeHtml(c.plateforme)} <span class="tag ${c.connecte ? 'done' : 'pending'}">${c.connecte ? 'connecte' : 'non connecte'}</span></h3>
          ${c.connecte && c.compte ? `<p class="connector-account">${escapeHtml(c.compte)}</p>` : ''}
          <p>DM : ${c.capacites.dm ? 'oui' : 'non'} · Lecture commentaires : ${c.capacites.lecture_commentaires ? 'oui' : 'non'} · Reponse commentaires : ${c.capacites.reponse_commentaires ? 'oui' : 'non'} · Publication : ${c.capacites.publication ? 'oui' : 'non'}<br/>
          ${c.raison ? escapeHtml(c.raison) : ''}</p>
        </div>
        <div class="entry-actions">
          ${!c.connecte && CONNECTOR_OAUTH_FLOWS[c.plateforme] ? `<button type="button" class="connect-connector-btn" data-connect-platform="${escapeHtml(c.plateforme)}" aria-label="Connecter ${escapeHtml(c.plateforme)} via ${CONNECTOR_OAUTH_FLOWS[c.plateforme].fournisseur}">Connecter</button>` : ''}
          <button data-plateforme="${escapeHtml(c.plateforme)}" class="test-connector-btn">Tester</button>
        </div>
      </div>
    `).join('');
    el.querySelectorAll('.test-connector-btn').forEach((btn) => {
      btn.addEventListener('click', () => testConnector(btn.dataset.plateforme));
    });
    el.querySelectorAll('.connect-connector-btn').forEach((btn) => {
      btn.addEventListener('click', () => startConnectorOAuth(btn.dataset.connectPlatform, btn));
    });
    el.querySelectorAll('img[data-avatar-img]').forEach((img) => {
      img.addEventListener('error', () => img.remove(), { once: true });
    });
  } catch (err) {
    el.innerHTML = emptyRow(`Erreur de chargement : ${err.message}`);
  }
}

function setMetaActionMessage(message, ok = false) {
  const el = document.getElementById('metaActionMsg');
  if (!el) return;
  el.className = `form-msg${ok ? ' ok' : ' error'}`;
  el.textContent = message;
}

async function startMetaOAuth() {
  setMetaActionMessage('Preparation de l’autorisation Meta...', false);
  try {
    const result = await api('/meta/oauth/start');
    if (!result.authorization_url) throw new Error('URL OAuth Meta absente');
    window.location.assign(result.authorization_url);
  } catch (err) {
    setMetaActionMessage(`Connexion Meta indisponible : ${err.message}`);
  }
}

async function testMetaConnection() {
  setMetaActionMessage('Verification réelle des tokens Meta...', false);
  try {
    const result = await api('/meta/test', { method: 'POST', body: JSON.stringify({}) });
    setMetaActionMessage(result.succes ? 'Tokens Meta valides et capacités mises à jour.' : `Test Meta échoué : ${result.raison || 'raison inconnue'}`, result.succes);
    await loadConnectors();
  } catch (err) {
    setMetaActionMessage(`Test Meta impossible : ${err.message}`);
  }
}

async function disconnectMeta() {
  if (!await showConfirmModal({ eyebrow: 'Réseaux sociaux', title: 'Déconnecter Facebook / Instagram ?', bodyHtml: '<p class="modal-body">Les tokens seront supprimés du serveur. Il faudra refaire la connexion OAuth pour publier à nouveau sur ces plateformes.</p>', confirmLabel: 'Déconnecter', danger: true })) return;
  try {
    await api('/meta/disconnect', { method: 'POST', body: JSON.stringify({ confirmation: true }) });
    setMetaActionMessage('Connexion Meta déconnectée et tokens supprimés du serveur.', true);
    await loadConnectors();
  } catch (err) {
    setMetaActionMessage(`Déconnexion impossible : ${err.message}`);
  }
}

function setYoutubeActionMessage(message, ok = false) {
  const el = document.getElementById('youtubeActionMsg');
  if (!el) return;
  el.className = `form-msg${ok ? ' ok' : ' error'}`;
  el.textContent = message;
}

async function startYoutubeOAuth() {
  setYoutubeActionMessage('Preparation de l’autorisation Google...', false);
  try {
    const result = await api('/youtube/oauth/start');
    if (!result.authorization_url) throw new Error('URL OAuth YouTube absente');
    window.location.assign(result.authorization_url);
  } catch (err) {
    setYoutubeActionMessage(`Connexion YouTube indisponible : ${err.message}`);
  }
}

async function testYoutubeConnection() {
  setYoutubeActionMessage('Verification réelle de la chaîne YouTube...', false);
  try {
    const result = await api('/youtube/test', { method: 'POST', body: JSON.stringify({}) });
    setYoutubeActionMessage(result.succes ? 'Chaîne YouTube validée et capacités mises à jour.' : `Test YouTube échoué : ${result.raison || 'raison inconnue'}`, result.succes);
    await loadConnectors();
  } catch (err) {
    setYoutubeActionMessage(`Test YouTube impossible : ${err.message}`);
  }
}

async function disconnectYoutube() {
  if (!await showConfirmModal({ eyebrow: 'Réseaux sociaux', title: 'Déconnecter YouTube ?', bodyHtml: '<p class="modal-body">Les tokens seront supprimés du serveur. Il faudra refaire la connexion OAuth pour publier à nouveau sur YouTube.</p>', confirmLabel: 'Déconnecter', danger: true })) return;
  try {
    const result = await api('/youtube/disconnect', { method: 'POST', body: JSON.stringify({ confirmation: true }) });
    setYoutubeActionMessage(result.revocation_google_confirmee ? 'Connexion YouTube déconnectée et token révoqué côté Google.' : 'Connexion YouTube déconnectée localement. La révocation Google n’a pas pu être confirmée.', true);
    await loadConnectors();
  } catch (err) {
    setYoutubeActionMessage(`Déconnexion impossible : ${err.message}`);
  }
}

function setTiktokActionMessage(message, ok = false) {
  const el = document.getElementById('tiktokActionMsg');
  if (!el) return;
  el.className = `form-msg${ok ? ' ok' : ' error'}`;
  el.textContent = message;
}

async function startTiktokOAuth() {
  setTiktokActionMessage('Preparation de l’autorisation TikTok...', false);
  try {
    const result = await api('/tiktok/oauth/start');
    if (!result.authorization_url) throw new Error('URL OAuth TikTok absente');
    window.location.assign(result.authorization_url);
  } catch (err) {
    setTiktokActionMessage(`Connexion TikTok indisponible : ${err.message}`);
  }
}

async function testTiktokConnection() {
  setTiktokActionMessage('Verification réelle du compte TikTok...', false);
  try {
    const result = await api('/tiktok/test', { method: 'POST', body: JSON.stringify({}) });
    setTiktokActionMessage(result.succes ? 'Compte TikTok valide et capacités mises à jour.' : `Test TikTok échoué : ${result.raison || 'raison inconnue'}`, result.succes);
    await loadConnectors();
  } catch (err) {
    setTiktokActionMessage(`Test TikTok impossible : ${err.message}`);
  }
}

async function readTiktokVideos() {
  setTiktokActionMessage('Lecture des vidéos TikTok autorisées...', false);
  try {
    const result = await api('/tiktok/read');
    const count = Array.isArray(result.videos) ? result.videos.length : 0;
    setTiktokActionMessage(`${count} vidéo(s) TikTok lue(s) avec l’autorisation actuelle.`, true);
  } catch (err) {
    setTiktokActionMessage(`Lecture TikTok impossible : ${err.message}`);
  }
}

async function disconnectTiktok() {
  if (!await showConfirmModal({ eyebrow: 'Réseaux sociaux', title: 'Déconnecter TikTok ?', bodyHtml: '<p class="modal-body">Les tokens seront supprimés du serveur. Il faudra refaire la connexion OAuth pour publier à nouveau sur TikTok.</p>', confirmLabel: 'Déconnecter', danger: true })) return;
  try {
    const result = await api('/tiktok/disconnect', { method: 'POST', body: JSON.stringify({ confirmation: true }) });
    setTiktokActionMessage(result.deconnecte ? 'Connexion TikTok déconnectée et tokens locaux supprimés.' : 'Déconnexion TikTok non confirmée.', result.deconnecte);
    await loadConnectors();
  } catch (err) {
    setTiktokActionMessage(`Déconnexion impossible : ${err.message}`);
  }
}

function publicationStatusClass(status) {
  const normalized = String(status || 'EN_TRAITEMENT').toUpperCase();
  if (normalized === 'PUBLIE') return 'done';
  if (normalized === 'ECHEC' || normalized === 'ERREUR_CONTROLE') return 'error';
  return 'pending';
}

function renderTiktokPublications(rows) {
  const el = document.getElementById('tiktokPublicationsList');
  if (!el) return;
  if (!Array.isArray(rows) || !rows.length) {
    el.innerHTML = emptyRow('Aucune soumission TikTok suivie.');
    return;
  }
  el.innerHTML = rows.slice(0, 20).map((row) => {
    const publishId = row && row.publish_id ? String(row.publish_id) : '';
    const status = row && row.statut ? String(row.statut) : 'EN_TRAITEMENT';
    const title = row && row.title ? row.title : 'Publication vidéo TikTok';
    const providerStatus = row && row.provider_status ? row.provider_status : 'en attente de vérification';
    return `<div class="entry tiktok-publication-entry">
      <div class="entry-stamp">${fmtTime(row.updated_at || row.soumis_at || row.created_at)}</div>
      <div class="entry-body">
        <h3>${escapeHtml(title)} <span class="tag ${publicationStatusClass(status)}">${escapeHtml(status.replace(/_/g, ' '))}</span></h3>
        <p class="review-meta">publish_id : <code>${escapeHtml(publishId || 'absent')}</code> · état TikTok : ${escapeHtml(providerStatus)}</p>
        <p class="review-meta">Confirme une publication uniquement si TikTok retourne un état final positif. La soumission seule ne suffit pas.</p>
      </div>
      <div class="entry-actions">${publishId ? `<button class="station-action" type="button" data-tiktok-publish-status="${escapeHtml(publishId)}">Actualiser</button>` : ''}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-tiktok-publish-status]').forEach((button) => {
    button.addEventListener('click', () => refreshTiktokPublicationStatus(button.dataset.tiktokPublishStatus));
  });
}

async function refreshTiktokPublicationStatus(publishId) {
  if (!publishId) return;
  setTiktokActionMessage('Lecture du statut TikTok en cours...', false);
  try {
    const result = await api(`/tiktok/publish-status?publication_id=${encodeURIComponent(publishId)}`);
    const ok = result.statut === 'PUBLIE';
    setTiktokActionMessage(`TikTok : ${result.statut || 'EN_TRAITEMENT'} · état fournisseur : ${result.provider_status || 'inconnu'}.`, ok);
    await loadDashboard();
  } catch (err) {
    setTiktokActionMessage(`Statut de publication TikTok indisponible : ${err.message}`);
  }
}

async function refreshAllTiktokPublicationStatuses() {
  const ids = [...document.querySelectorAll('[data-tiktok-publish-status]')]
    .map((button) => button.dataset.tiktokPublishStatus)
    .filter(Boolean);
  if (!ids.length) {
    await loadDashboard();
    return;
  }
  setTiktokActionMessage(`Vérification de ${ids.length} soumission(s) TikTok...`, false);
  try {
    for (const publishId of ids) {
      await api(`/tiktok/publish-status?publication_id=${encodeURIComponent(publishId)}`);
    }
    setTiktokActionMessage('Statuts TikTok actualisés. Une confirmation positive vient uniquement de l’état final retourné par TikTok.', true);
    await loadDashboard();
  } catch (err) {
    setTiktokActionMessage(`Actualisation TikTok incomplète : ${err.message}`);
  }
}

async function testConnector(plateforme) {
  try {
    const result = await api('/connectors', { method: 'POST', body: JSON.stringify({ plateforme }) });
    alert(result.succes ? `Connexion "${plateforme}" reussie.` : `Test echoue pour "${plateforme}" : ${result.raison || 'raison inconnue'}`);
    await loadConnectors();
  } catch (err) {
    alert(`Erreur de test : ${err.message}`);
  }
}

/* --- Modes, base de connaissances et commercial ----------------------------*/

const settingsState = { settings: null };

/*
 * SOURCE UNIQUE DE VÉRITÉ POUR LE MODE / THÈME.
 * AUDIT (bug critique corrigé) : le gestionnaire de clic sur un bouton de
 * mode faisait auparavant `document.body.dataset.mode = requestedMode`
 * IMMÉDIATEMENT après confirmation de la modale, AVANT tout appel réseau —
 * alors que la sauvegarde réelle n'a lieu que si l'utilisateur clique
 * ensuite sur "Enregistrer les paramètres". Conséquence réelle : le thème
 * visuel entier (accent, fond, badges — voir style.css body[data-mode]),
 * ainsi que la Vue générale, changeaient de façon optimiste avant toute
 * confirmation serveur. Si l'utilisateur quittait la page, rechargeait, ou
 * si l'enregistrement échouait, le frontend restait bloqué sur un mode
 * jamais réellement appliqué côté serveur — exactement le scénario
 * "Paramètres = CONQUISTADOR / Vue générale = SILENCIO" à corriger.
 *
 * Désormais : applyConfirmedMode() est le SEUL endroit qui touche
 * document.body.dataset.mode, et n'est appelé qu'avec une valeur confirmée
 * par le serveur (réponse de /dashboard, /settings, ou d'un PUT /settings
 * réussi). Le clic sur un bouton de mode ne fait plus que "proposer" une
 * sélection dans le formulaire (classe .mode-btn-pending), sans toucher au
 * thème ni à l'état affiché ailleurs tant que la sauvegarde n'a pas réussi.
 */
function applyConfirmedMode(mode, { policy } = {}) {
  const safeMode = ['silencio', 'copilot', 'conquistador'].includes(mode) ? mode : 'silencio';
  if (document.body) document.body.dataset.mode = safeMode;
  document.querySelectorAll('.mode-btn').forEach((button) => {
    const isCurrent = button.dataset.mode === safeMode;
    button.classList.toggle('active', isCurrent);
    button.classList.remove('mode-btn-pending');
    button.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
  });
  const badge = document.getElementById('modeBadge');
  if (badge) {
    badge.textContent = safeMode.toUpperCase();
    badge.className = `mode-badge mode-badge-${safeMode}`;
  }
  const ovLabel = document.getElementById('ovModeLabel');
  if (ovLabel) ovLabel.textContent = `Mode : ${safeMode.toUpperCase()}`;
  const ovDesc = document.getElementById('ovModeDesc');
  if (ovDesc) ovDesc.textContent = (policy && policy.description) || MODE_DESCRIPTIONS[safeMode] || '';
  return safeMode;
}

function setFormMessage(id, message, ok = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `form-msg${ok ? ' ok' : ' error'}`;
  el.textContent = message;
}

function renderSettings(settings) {
  settingsState.settings = settings;
  const mode = settings?.mode || 'silencio';
  applyConfirmedMode(mode, { policy: settings?.mode_policy });
  const campaign = settings?.campaign || {};
  const enabled = document.getElementById('campaignEnabled');
  const max = document.getElementById('campaignMaxPosts');
  if (enabled) enabled.checked = campaign.enabled === true;
  if (max) max.value = Number.isFinite(Number(campaign.max_publications_per_day)) ? campaign.max_publications_per_day : 0;
  const qminEl = document.getElementById('campaignQualityMin');
  if (qminEl) qminEl.value = Number.isFinite(Number(campaign.quality_min_score)) ? campaign.quality_min_score : 85;
  const tzEl = document.getElementById('campaignTimezone');
  if (tzEl && campaign.timezone) tzEl.value = campaign.timezone;
  const hoursEl = document.getElementById('campaignHours');
  if (hoursEl) hoursEl.value = Array.isArray(campaign.allowed_hours) ? campaign.allowed_hours.join(',') : '';
  document.querySelectorAll('[data-campaign-platform]').forEach((checkbox) => {
    checkbox.checked = Array.isArray(campaign.allowed_platforms) && campaign.allowed_platforms.includes(checkbox.value);
  });
  const status = document.getElementById('modeStatus');
  if (status) {
    const campaignText = campaign.enabled
      ? `campagne autonome configurée à ${campaign.max_publications_per_day || 0} publication(s)/jour`
      : 'campagne automatique désactivée';
    const tzText = campaign.timezone ? ` · fuseau ${campaign.timezone} (seuil qualité ${Number.isFinite(Number(campaign.quality_min_score)) ? campaign.quality_min_score : 85}/100)` : '';
    const policy = settings?.mode_policy || {};
    status.textContent = `Mode actif : ${policy.label || mode}. ${policy.description || ''} ${campaignText}. Approbation humaine et kill switch obligatoires.`;
  }
}

async function loadSettings() {
  try {
    const result = await api('/settings');
    renderSettings(result.settings);
  } catch (err) {
    setFormMessage('settingsMsg', `Paramètres indisponibles : ${err.message}`);
  }
}

async function changeMode(requestedMode, button) {
  const campaign = settingsState.settings?.campaign || {};
  const previousLabel = button.textContent;
  button.disabled = true;
  button.classList.add('mode-btn-loading');
  setFormMessage('settingsMsg', `Application du mode ${requestedMode.toUpperCase()} en cours...`);
  try {
    const result = await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({ mode: requestedMode, campaign, reason: 'Changement de mode depuis le tableau de bord' }),
    });
    // Seul point d'application reel : renderSettings() -> applyConfirmedMode()
    // avec la valeur RENVOYEE PAR LE SERVEUR, jamais la valeur demandee.
    renderSettings(result.settings);
    setFormMessage('settingsMsg', `Mode ${requestedMode.toUpperCase()} appliqué.`, true);
  } catch (err) {
    // Echec : aucun rollback visuel necessaire, puisqu'aucune mutation
    // optimiste n'a eu lieu. Le mode affiche reste exactement celui du
    // serveur (inchange).
    setFormMessage('settingsMsg', `Échec du changement de mode : ${err.message}. Le mode actif reste ${(settingsState.settings?.mode || 'silencio').toUpperCase()}.`);
  } finally {
    button.disabled = false;
    button.classList.remove('mode-btn-loading');
    button.textContent = previousLabel;
  }
}

async function saveSettings() {
  const max = Math.max(0, Math.min(20, Number(document.getElementById('campaignMaxPosts')?.value || 0)));
  const qmin = Math.max(0, Math.min(100, Number(document.getElementById('campaignQualityMin')?.value || 85)));
  const hours = String(document.getElementById('campaignHours')?.value || '')
    .split(',').map((h) => parseInt(h.trim(), 10)).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  const campaign = {
    enabled: document.getElementById('campaignEnabled')?.checked === true,
    max_publications_per_day: Number.isFinite(max) ? Math.floor(max) : 0,
    allowed_platforms: [...document.querySelectorAll('[data-campaign-platform]:checked')].map((item) => item.value),
    quality_min_score: Number.isFinite(qmin) ? Math.floor(qmin) : 85,
    allowed_hours: [...new Set(hours)],
    timezone: String(document.getElementById('campaignTimezone')?.value || 'Africa/Bujumbura').trim() || 'Africa/Bujumbura',
  };
  setFormMessage('settingsMsg', 'Enregistrement des paramètres côté serveur...');
  try {
    const result = await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({ mode: settingsState.settings?.mode || 'silencio', campaign, reason: 'Modification depuis le dashboard' }),
    });
    renderSettings(result.settings);
    setFormMessage('settingsMsg', 'Paramètres persistés. Aucune publication n’a été déclenchée.', true);
  } catch (err) {
    setFormMessage('settingsMsg', `Paramètres non enregistrés : ${err.message}`);
  }
}

function renderKnowledge(references) {
  const el = document.getElementById('knowledgeList');
  if (!el) return;
  if (!Array.isArray(references) || !references.length) {
    el.innerHTML = emptyRow('Aucune référence de connaissance enregistrée.');
    return;
  }
  el.innerHTML = references.map((row) => {
    const data = row.data || {};
    const source = data.source_url && /^https:\/\//i.test(data.source_url)
      ? `<a href="${escapeHtml(data.source_url)}" target="_blank" rel="noreferrer">source HTTPS</a>`
      : 'source non fournie';
    const excerpt = String(data.content || '').slice(0, 240);
    const assetType = data.asset_type || 'text';
    const official = data.official === true ? ' · officielle' : '';
    return `<div class="entry"><div class="entry-stamp">${fmtTime(row.created_at)}</div><div class="entry-body"><h3>${escapeHtml(data.title || 'Référence sans titre')} <span class="tag done">${escapeHtml(data.category || 'general')}</span></h3><p>${escapeHtml(excerpt)}${data.content && data.content.length > 240 ? '…' : ''}<br/>Type : ${escapeHtml(assetType)}${official} · ${source}</p></div><div class="entry-actions"></div></div>`;
  }).join('');
}

async function loadKnowledge() {
  try {
    const result = await api('/knowledge?limit=20');
    renderKnowledge(result.references);
  } catch (err) {
    const el = document.getElementById('knowledgeList');
    if (el) el.innerHTML = emptyRow(`Base indisponible : ${err.message}`);
  }
}

async function addKnowledge() {
  const title = document.getElementById('knowledgeTitle')?.value.trim() || '';
  const category = document.getElementById('knowledgeCategory')?.value.trim() || 'general';
  const asset_type = document.getElementById('knowledgeAssetType')?.value || 'text';
  const official = document.getElementById('knowledgeOfficial')?.checked === true;
  const source_url = document.getElementById('knowledgeSourceUrl')?.value.trim() || '';
  const content = document.getElementById('knowledgeContent')?.value.trim() || '';
  setFormMessage('knowledgeMsg', 'Validation et enregistrement de la référence...');
  try {
    await api('/knowledge', { method: 'POST', body: JSON.stringify({ title, category, asset_type, official, source_url, content }) });
    ['knowledgeTitle', 'knowledgeCategory', 'knowledgeSourceUrl', 'knowledgeContent'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const assetTypeEl = document.getElementById('knowledgeAssetType');
    if (assetTypeEl) assetTypeEl.value = 'text';
    const officialEl = document.getElementById('knowledgeOfficial');
    if (officialEl) officialEl.checked = false;
    setFormMessage('knowledgeMsg', 'Référence ajoutée à la mémoire persistante.', true);
    await Promise.all([loadKnowledge(), loadDashboard()]);
  } catch (err) {
    setFormMessage('knowledgeMsg', `Référence non ajoutée : ${err.message}`);
  }
}

async function loadVoiceHealth() {
  const el = document.getElementById('voiceHealthStatus');
  if (!el) return;
  try {
    const result = await api('/voice/health');
    const voice = result.voix || {};
    el.textContent = voice.available
      ? `Studio disponible : ${voice.voice || 'Rémy Neural'} · ${voice.provider || 'fournisseur configuré'}.`
      : `Studio non disponible : ${voice.reason || 'URL HTTPS durable non configurée'}.`;
    el.className = `voice-health-line ${voice.available ? 'ok' : 'warning'}`;
  } catch (err) {
    el.textContent = `Diagnostic vocal indisponible : ${err.message}`;
    el.className = 'voice-health-line warning';
  }
}

async function generateVoice() {
  const text = document.getElementById('voiceText')?.value.trim() || '';
  const audio = document.getElementById('voiceAudio');
  setFormMessage('voiceMsg', 'Génération Rémy Neural en cours...');
  try {
    const headers = { 'Content-Type': 'application/json' };
    const key = apiKey();
    if (key) headers['x-conquistador-key'] = key;
    const response = await fetch(`${API}/voice/generate`, { method: 'POST', headers, body: JSON.stringify({ text }) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.erreur || `Erreur HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error('Le studio n’a renvoyé aucun audio.');
    if (audio) {
      if (audio.dataset.objectUrl) URL.revokeObjectURL(audio.dataset.objectUrl);
      const objectUrl = URL.createObjectURL(blob);
      audio.dataset.objectUrl = objectUrl;
      audio.src = objectUrl;
      audio.hidden = false;
    }
    setFormMessage('voiceMsg', 'MP3 généré. Il reste dans ce navigateur et n’est pas publié automatiquement.', true);
  } catch (err) {
    setFormMessage('voiceMsg', `MP3 non généré : ${err.message}`);
  }
}

function renderCommercialResult(output) {
  const el = document.getElementById('commercialResult');
  if (!el) return;
  const data = output && typeof output === 'object' ? output : {};
  const prepared = data.message_prive_prepare || data.reponse_publique_preparee || null;
  el.innerHTML = `<div class="pipeline-result ${data.intention_achat_detectee ? 'pipeline-result-ready' : 'pipeline-result-blocked'}"><div class="pipeline-result-head"><strong>${escapeHtml(data.statut || 'ANALYSE_TERMINEE')}</strong><span>${data.dm_possible ? 'DM possible selon le connecteur réel' : 'Aucun envoi de message effectué'}</span></div><p class="pipeline-result-note">Plateforme : ${escapeHtml(data.plateforme || 'inconnue')} · Mots-clés : ${escapeHtml((data.mots_cles_trouves || []).join(', ') || 'aucun')}</p><div class="pipeline-result-grid"><div><h4>Action recommandée</h4><p>${escapeHtml(data.action_recommandee || 'aucune_action')}</p></div><div><h4>Réponse préparée</h4><p>${escapeHtml(prepared ? JSON.stringify(prepared) : 'Aucune réponse préparée.')}</p></div></div><p class="pipeline-result-final"><strong>Envoi :</strong> toujours séparé, soumis à approbation et jamais déclenché par cet écran.</p></div>`;
}

async function runCommercial() {
  const message = document.getElementById('commercialMessage')?.value.trim() || '';
  const plateforme = document.getElementById('commercialPlatform')?.value || 'tiktok';
  setFormMessage('commercialMsg', 'Analyse de l’intention en cours...');
  try {
    const { tache } = await api('/tasks', { method: 'POST', body: JSON.stringify({ type: 'commercial.detect_comment_intent', priority: 'normale', input: { commentaire: message, plateforme }, executeNow: true }) });
    renderCommercialResult(tache?.data?.result?.output || {});
    setFormMessage('commercialMsg', 'Analyse terminée : aucune action externe n’a été envoyée.', true);
    await Promise.all([loadTasks(), loadDashboard()]);
  } catch (err) {
    setFormMessage('commercialMsg', `Analyse impossible : ${err.message}`);
  }
}

function renderFollowupResult(output) {
  const el = document.getElementById('followupResult');
  if (!el) return;
  const data = output && typeof output === 'object' ? output : {};
  el.innerHTML = `<div class="pipeline-result pipeline-result-ready"><div class="pipeline-result-head"><strong>${escapeHtml(data.statut || 'RELANCE_PREPAREE')}</strong><span>envoi effectué : non</span></div><p class="pipeline-result-note">Délai proposé : ${escapeHtml(String(data.delai_jours || 3))} jour(s) · canal : ${escapeHtml(data.plateforme || 'inconnu')}</p><p>${escapeHtml(data.message || 'Message de relance non disponible.')}</p><p class="pipeline-result-final"><strong>Protection :</strong> une approbation et un connecteur réel seront nécessaires avant tout envoi.</p></div>`;
}

function renderFollowups(rows) {
  const el = document.getElementById('commercialFollowupsList');
  if (!el) return;
  if (!Array.isArray(rows) || !rows.length) {
    el.innerHTML = emptyRow('Aucun historique de relance chargé.');
    return;
  }
  el.innerHTML = rows.slice(0, 20).map((row) => {
    const data = row && row.data ? row.data : {};
    const followup = data.followup && typeof data.followup === 'object' ? data.followup : {};
    return `<div class="entry"><div class="entry-stamp">${fmtTime(row.created_at || data.at)}</div><div class="entry-body"><h3>${escapeHtml(followup.contact_key || data.contact_key || 'Contact non renseigné')} <span class="tag prepared">${escapeHtml(followup.statut || 'RELANCE_PREPAREE')}</span></h3><p>${escapeHtml(followup.message || 'Message non disponible')}<br/>Canal : ${escapeHtml(followup.plateforme || data.plateforme || 'inconnu')} · Envoi : jamais effectué automatiquement.</p></div><div class="entry-actions"></div></div>`;
  }).join('');
}

async function prepareCommercialFollowup() {
  setFormMessage('followupMsg', 'Préparation et persistance de la relance...');
  try {
    const input = {
      contact_key: document.getElementById('commercialFollowupContact')?.value.trim() || '',
      nom: document.getElementById('commercialFollowupName')?.value.trim() || '',
      sujet: document.getElementById('commercialFollowupSubject')?.value.trim() || '',
      delai_jours: Number(document.getElementById('commercialFollowupDelay')?.value || 3),
      plateforme: document.getElementById('commercialPlatform')?.value || 'inconnue',
    };
    const { tache } = await api('/tasks', { method: 'POST', body: JSON.stringify({ type: 'commercial.prepare_followup', priority: 'normale', input, executeNow: true }) });
    const output = tache?.data?.result?.output || {};
    renderFollowupResult(output);
    setFormMessage('followupMsg', 'Relance enregistrée. Aucun message n’a été envoyé.', true);
    await Promise.all([loadTasks(), loadDashboard()]);
  } catch (err) {
    setFormMessage('followupMsg', `Relance impossible : ${err.message}`);
  }
}

/* --- Tableau de bord agrege -------------------------------------------------*/

const CONTENT_STATE_LABELS = {
  creation: 'Création',
  en_controle: 'En contrôle',
  corrections_requises: 'Corrections requises',
  validee: 'Validée',
  prete_a_publier: 'Prête à publier',
  en_attente_approbation: 'En attente d’approbation',
  publiee: 'Publiée',
  erreur: 'Erreur',
};

function reviewItems(items, fallback = 'Aucun élément signalé.') {
  if (!Array.isArray(items) || !items.length) return `<p class="pipeline-ok">${escapeHtml(fallback)}</p>`;
  return `<ul>${items.slice(0, 8).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderContentStates(summary) {
  const el = document.getElementById('contentStateGrid');
  if (!el) return;
  const counts = summary && summary.par_etat && typeof summary.par_etat === 'object' ? summary.par_etat : {};
  const states = Array.isArray(summary?.etats_disponibles) && summary.etats_disponibles.length
    ? summary.etats_disponibles
    : Object.entries(CONTENT_STATE_LABELS).map(([id, label]) => ({ id, label }));
  el.innerHTML = states.map((state) => `
    <div class="content-state-cell" data-state="${escapeHtml(state.id)}">
      <strong>${Number(counts[state.id] || 0)}</strong>
      <span>${escapeHtml(state.label || CONTENT_STATE_LABELS[state.id] || state.id)}</span>
    </div>
  `).join('');
}

function renderVideoReviews(reviews) {
  const el = document.getElementById('videoReviewsList');
  if (!el) return;
  if (!Array.isArray(reviews) || !reviews.length) {
    el.innerHTML = emptyRow('Aucune revue vidéo persistée. Lancez le pipeline pour créer un premier contrôle.');
    return;
  }
  el.innerHTML = reviews.slice(0, 20).map((row) => {
    const data = row && row.data ? row.data : {};
    const review = data.review && typeof data.review === 'object' ? data.review : {};
    const conforme = review.conforme === true;
    const state = conforme ? 'validee' : 'corrections_requises';
    const problems = review.problemes_identifies || review.problemes || [];
    const corrections = review.corrections_demandees || [];
    const missing = review.preuves_manquantes || [];
    const title = data.content_title || review.content_title || (data.task_id ? `Contenu de la tâche ${String(data.task_id).slice(0, 8)}…` : 'Revue vidéo');
    return `
      <div class="entry video-review-entry">
        <div class="entry-stamp">${fmtTime(row.updated_at || row.created_at || data.at)}</div>
        <div class="entry-body">
          <h3>${escapeHtml(title)} <span class="tag ${conforme ? 'done' : 'error'}">${escapeHtml(CONTENT_STATE_LABELS[state])}</span></h3>
          <p class="review-meta">${escapeHtml(review.statut || (conforme ? 'CONFORME' : 'CORRECTIONS_REQUISES'))} · publication automatique : jamais autorisée</p>
          <details>
            <summary>Voir le rapport du contrôleur</summary>
            <div class="pipeline-result-grid">
              <div><h4>Problèmes identifiés</h4>${reviewItems(problems)}</div>
              <div><h4>Corrections demandées</h4>${reviewItems(corrections, 'Aucune correction structurée.')}</div>
              <div><h4>Preuves manquantes</h4>${reviewItems(missing, 'Aucune preuve manquante.')}</div>
              <div><h4>Note</h4><p>${escapeHtml(review.note || 'Le rapport ne fournit pas de note complémentaire.')}</p></div>
            </div>
          </details>
        </div>
        <div class="entry-actions"></div>
      </div>`;
  }).join('');
}

async function loadDashboard() {
  try {
    const data = await api('/dashboard');
    dashboardState.last = data;
    renderStats(data.statistiques);
    renderProspects(data.prospects);
    renderExecutions(data.executions);
    renderErrors(data.erreurs);
    renderContentStates(data.etats_contenu);
    renderVideoReviews(data.revues_video);
    renderFollowups(data.relances_commerciales);
    renderTiktokPublications(data.tiktok_publications);
    renderOverview(data);
    renderCommercialSummary(data.resume_commercial);
    renderContentRanking(data.classement_contenus);
    renderChariowStatus(data.chariow);
    populateTimezoneOptions(data.fuseaux_horaires_disponibles);
    if (data.objectifs_hebdomadaires && data.progres_hebdomadaire) {
      renderObjectives(data.objectifs_hebdomadaires, { progres: data.progres_hebdomadaire.progres });
    } else {
      await loadObjectivesAndProgress();
    }
    if (data.comparaison_semaine && periodState.offset === 0 && periodState.granularite === 'semaine') {
      renderPeriodComparison(data.comparaison_semaine);
    } else {
      await loadPeriodComparison();
    }
    renderNotifications(computeNotifications(data));
  } catch (err) {
    document.getElementById('statGrid').innerHTML = emptyRow(`Erreur : ${err.message}`);
    const reviewList = document.getElementById('videoReviewsList');
    if (reviewList) reviewList.innerHTML = emptyRow(`États et revues indisponibles : ${err.message}`);
  }
}

function renderStats(stats) {
  const el = document.getElementById('statGrid');
  if (!stats || !stats.totaux) {
    el.innerHTML = emptyRow('Aucune statistique enregistree pour le moment.');
    return;
  }
  const labels = {
    vues: 'Vues', commentaires: 'Commentaires', partages: 'Partages', abonnes: 'Abonnes',
    clics: 'Clics', prospects: 'Prospects', ventes: 'Ventes', conversions: 'Conversions',
    abonnes_gagnes: 'Abonnés gagnés', abonnes_perdus: 'Abonnés perdus', enregistrements: 'Enregistrements',
    likes: 'Likes', chiffre_affaires: "Chiffre d'affaires",
  };
  el.innerHTML = Object.entries(stats.totaux).map(([key, val]) => `
    <div class="stat-cell"><span class="n">${val}</span><span class="label">${labels[key] || key}</span></div>
  `).join('');
  const sourceEl = document.getElementById('sourceStats');
  if (sourceEl) {
    const sources = stats.par_source && typeof stats.par_source === 'object' ? Object.entries(stats.par_source) : [];
    sourceEl.innerHTML = sources.length
      ? sources.map(([source, values]) => `<div class="source-stat"><strong>${escapeHtml(source)}</strong><span>${values.entrees || 0} entrée(s) · ${values.vues || 0} vue(s) · ${values.ventes || 0} vente(s)</span></div>`).join('')
      : '<div class="empty">Aucune donnée par source enregistrée sur la période.</div>';
    const chart = document.getElementById('sourceViewsChart');
    if (chart) {
      const maxViews = Math.max(0, ...sources.map(([, values]) => Number(values.vues || 0)));
      chart.innerHTML = sources.length && maxViews > 0
        ? `<div class="metric-chart-head"><strong>Vues par source</strong><span>période depuis ${escapeHtml(stats.periode_depuis || 'inconnue')}</span></div><div class="metric-bars">${sources.map(([source, values]) => {
          const views = Number(values.vues || 0);
          const width = maxViews ? Math.max(3, Math.round((views / maxViews) * 100)) : 0;
          return `<div class="metric-bar-row"><span>${escapeHtml(source)}</span><div class="metric-bar-track"><i style="width:${width}%"></i></div><strong>${views}</strong></div>`;
        }).join('')}</div><p class="chart-note">Calcul basé uniquement sur les métriques enregistrées ; aucune performance n’est estimée.</p>`
        : '<div class="empty">Aucune vue réelle enregistrée pour tracer ce graphique.</div>';
    }
  }
}

/* ============================ OBJECTIFS DE LA SEMAINE ==================== */
const OBJECTIVE_LABELS = {
  chiffre_affaires: "Chiffre d'affaires", ventes: 'Ventes', nouveaux_prospects: 'Nouveaux prospects',
  vues: 'Vues', nouveaux_abonnes: 'Nouveaux abonnés', contenus_publies: 'Contenus publiés',
  conversations_commerciales: 'Conversations commerciales', prospects_convertis: 'Prospects convertis',
  engagement: 'Engagement', visites_boutique: 'Visites boutique', clics: 'Clics', conversions: 'Conversions',
};
const OBJECTIVE_ICONS = {
  chiffre_affaires: '💰', ventes: '🛒', nouveaux_prospects: '👥', vues: '📈', nouveaux_abonnes: '👤', contenus_publies: '🎬',
  conversations_commerciales: '💬', prospects_convertis: '✅', engagement: '❤️', visites_boutique: '🏬', clics: '👆', conversions: '🔁',
};
const OBJECTIVE_FIELD_INPUT_IDS = {
  chiffre_affaires: 'objChiffreAffaires', ventes: 'objVentes', nouveaux_prospects: 'objNouveauxProspects',
  vues: 'objVues', nouveaux_abonnes: 'objNouveauxAbonnes', contenus_publies: 'objContenusPublies',
  conversations_commerciales: 'objConversations', prospects_convertis: 'objProspectsConvertis',
  engagement: 'objEngagement', visites_boutique: 'objVisitesBoutique', clics: 'objClics', conversions: 'objConversions',
};
const OBJECTIVE_ORDER_MAIN = ['chiffre_affaires', 'ventes', 'nouveaux_prospects', 'vues', 'nouveaux_abonnes', 'contenus_publies'];
const OBJECTIVE_ORDER_ALL = [...OBJECTIVE_ORDER_MAIN, 'conversations_commerciales', 'prospects_convertis', 'engagement', 'visites_boutique', 'clics', 'conversions'];

function formatNumber(n) {
  return new Intl.NumberFormat('fr-FR').format(Math.round(Number(n || 0) * 100) / 100);
}

function objectiveCardHtml(field, p) {
  const icon = OBJECTIVE_ICONS[field] || '🎯';
  const label = OBJECTIVE_LABELS[field] || field;
  const pct = p.pourcentage;
  const depassed = pct !== null && pct > 100;
  const atteint = pct !== null && pct >= 100 && !depassed;
  const barWidth = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  let badge = '';
  if (pct === null) badge = '<span class="objective-badge non-defini">Non défini</span>';
  else if (depassed) badge = `<span class="objective-badge depassed">🎯 Objectif dépassé — ${pct}%</span>`;
  else if (atteint) badge = '<span class="objective-badge atteint">✅ Objectif atteint</span>';
  return `
    <div class="objective-card">
      <div class="objective-card-head"><h4>${icon} ${escapeHtml(label)}</h4>${badge}</div>
      <div class="objective-card-values"><strong>${formatNumber(p.actuel)}</strong> / ${p.objectif > 0 ? formatNumber(p.objectif) : '—'}</div>
      <div class="objective-bar-track${depassed ? ' depassed' : ''}"><i style="width:${barWidth}%"></i></div>
      <div class="objective-pct">${pct === null ? 'Aucun objectif défini pour ce champ' : `${pct}% de l'objectif`}</div>
    </div>`;
}

function renderObjectives(objectifsData, progresData) {
  objectivesState.objectifs = objectifsData;
  objectivesState.progres = progresData;

  if (objectifsData && objectifsData.objectifs) {
    for (const field of OBJECTIVE_ORDER_ALL) {
      const input = document.getElementById(OBJECTIVE_FIELD_INPUT_IDS[field]);
      if (input && document.activeElement !== input) {
        const val = objectifsData.objectifs[field];
        input.value = val ? val : '';
      }
    }
  }

  const el = document.getElementById('objectivesProgress');
  if (!el) return;
  if (!progresData || !progresData.progres) {
    el.innerHTML = emptyRow('Aucune progression disponible pour le moment.');
    return;
  }
  const cards = OBJECTIVE_ORDER_MAIN.map((field) => objectiveCardHtml(field, progresData.progres[field] || { actuel: 0, objectif: 0, pourcentage: null })).join('');
  const avancesDefinis = OBJECTIVE_ORDER_ALL.slice(OBJECTIVE_ORDER_MAIN.length)
    .filter((field) => (progresData.progres[field]?.objectif || 0) > 0);
  const avancesHtml = avancesDefinis.length
    ? `<h4 class="objectives-avances-title">Objectifs avancés atteints/en cours</h4><div class="objectives-grid">${avancesDefinis.map((field) => objectiveCardHtml(field, progresData.progres[field])).join('')}</div>`
    : '';
  el.innerHTML = `<div class="objectives-grid">${cards}</div>${avancesHtml}`;
}

async function saveObjectives() {
  const payload = {};
  for (const field of OBJECTIVE_ORDER_ALL) {
    const input = document.getElementById(OBJECTIVE_FIELD_INPUT_IDS[field]);
    if (!input) continue;
    const raw = input.value.trim();
    if (raw === '') continue; // champ laisse vide -> ne touche pas a la valeur deja enregistree
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) payload[field] = n;
  }
  setFormMessage('objectivesMsg', 'Enregistrement des objectifs...');
  try {
    await api('/weekly-objectives', { method: 'POST', body: JSON.stringify(payload) });
    setFormMessage('objectivesMsg', 'Objectifs enregistrés.', true);
    await loadObjectivesAndProgress();
  } catch (err) {
    setFormMessage('objectivesMsg', `Erreur : ${err.message}`);
  }
}

async function loadObjectivesAndProgress() {
  try {
    const data = await api('/weekly-objectives');
    renderObjectives(data.objectifs, data.progres);
  } catch (err) {
    const el = document.getElementById('objectivesProgress');
    if (el) el.innerHTML = emptyRow(`Objectifs indisponibles : ${err.message}`);
  }
}

const PERIOD_COMPARE_FIELDS = ['vues', 'ventes', 'chiffre_affaires', 'prospects', 'conversions', 'clics', 'abonnes_gagnes', 'likes'];
const STAT_LABELS_PERIOD = {
  vues: 'Vues', ventes: 'Ventes', chiffre_affaires: "Chiffre d'affaires", prospects: 'Prospects',
  conversions: 'Conversions', clics: 'Clics', abonnes_gagnes: 'Abonnés gagnés', likes: 'Likes',
};

function periodCompareCellHtml(label, c) {
  const deltaClass = c.variation > 0 ? 'up' : (c.variation < 0 ? 'down' : '');
  const arrow = c.variation > 0 ? '▲' : (c.variation < 0 ? '▼' : '—');
  const pctText = c.comparaison_possible === false
    ? 'Comparaison impossible (aucune donnée sur la période précédente)'
    : (c.variation_pourcentage === null ? '—' : `${c.variation_pourcentage > 0 ? '+' : ''}${c.variation_pourcentage}%`);
  return `
    <div class="period-compare-cell">
      <strong>${escapeHtml(label)}</strong>
      <div>${formatNumber(c.periode_actuelle)} (période préc. : ${formatNumber(c.periode_precedente)})</div>
      <div class="period-compare-delta ${deltaClass}">${arrow} ${pctText}</div>
    </div>`;
}

function periodLabel(data) {
  const g = data.granularite === 'mois' ? 'mois' : 'semaine';
  if (periodState.offset === 0) return g === 'mois' ? 'Ce mois vs mois précédent' : 'Cette semaine vs semaine précédente';
  const start = new Date(data.periode_actuelle.debut);
  return `${g === 'mois' ? 'Mois' : 'Semaine'} du ${start.toLocaleDateString('fr-FR')} vs période antérieure`;
}

function renderPeriodComparison(data) {
  const el = document.getElementById('periodComparison');
  if (!el) return;
  if (!data || !data.comparaison) {
    el.innerHTML = emptyRow('Comparaison indisponible.');
    return;
  }
  const cells = PERIOD_COMPARE_FIELDS
    .filter((f) => data.comparaison[f])
    .map((f) => periodCompareCellHtml(STAT_LABELS_PERIOD[f] || f, data.comparaison[f]))
    .join('');
  const labelEl = document.getElementById('periodOffsetLabel');
  if (labelEl) labelEl.textContent = periodLabel(data);
  const newerBtn = document.getElementById('periodNewerBtn');
  if (newerBtn) newerBtn.disabled = periodState.offset === 0;
  el.innerHTML = `<div class="period-compare-grid">${cells}</div>`;
}

async function loadPeriodComparison() {
  const el = document.getElementById('periodComparison');
  if (el) el.innerHTML = '<div class="empty">Chargement...</div>';
  try {
    const { tache } = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        type: 'stats.period_comparison',
        input: { granularite: periodState.granularite, offset: periodState.offset },
        executeNow: true,
      }),
    });
    renderPeriodComparison(tache.data && tache.data.result ? tache.data.result.output : null);
  } catch (err) {
    if (el) el.innerHTML = emptyRow(`Comparaison indisponible : ${err.message}`);
  }
}

function renderProspects(prospects) {
  const el = document.getElementById('prospectsList');
  if (!prospects || !prospects.length) {
    el.innerHTML = emptyRow('Aucun prospect enregistre pour le moment.');
    return;
  }
  el.innerHTML = prospects.slice(0, 15).map((c) => `
    <div class="entry">
      <div class="entry-stamp">${fmtTime(c.created_at)}</div>
      <div class="entry-body">
        <h3>${escapeHtml(c.data.nom || c.data.identifiant)}</h3>
        <p>Canal : ${escapeHtml(c.data.canal || 'inconnu')} · ${(c.data.historique || []).length} interaction(s)</p>
      </div>
      <div class="entry-actions"></div>
    </div>
  `).join('');
}

function renderExecutions(executions) {
  const el = document.getElementById('executionsList');
  if (!executions || !executions.length) {
    el.innerHTML = emptyRow("Aucune execution enregistree pour le moment. Question : \"Qu'est-ce que Conquistador a fait aujourd'hui ?\" — reponse : rien pour l'instant.");
    return;
  }
  el.innerHTML = executions.slice(0, 20).map((e) => `
    <div class="entry">
      <div class="entry-stamp">${escapeHtml(e.data.date)} ${escapeHtml(e.data.heure)}</div>
      <div class="entry-body">
        <h3>${escapeHtml(e.data.workflow)} <span class="tag ${e.data.resultat === 'succes' ? 'done' : (e.data.resultat === 'erreur' ? 'error' : 'pending')}">${escapeHtml(e.data.resultat)}</span></h3>
        <p>Action : ${escapeHtml(e.data.action)} · Duree : ${e.data.duree_ms} ms ${e.data.fournisseur_ia ? `· <span class="provider-used">IA utilisee : ${escapeHtml(e.data.fournisseur_ia)}</span>` : '· IA : non utilisee'} ${e.data.erreur ? '· ' + escapeHtml(e.data.erreur) : ''}</p>
      </div>
      <div class="entry-actions"></div>
    </div>
  `).join('');
}

function renderErrors(errors) {
  const el = document.getElementById('errorsList');
  if (!errors || !errors.length) {
    el.innerHTML = emptyRow('Aucune erreur enregistree. Bon signe.');
    return;
  }
  el.innerHTML = errors.slice(0, 15).map((e) => `
    <div class="entry">
      <div class="entry-stamp">${fmtTime(e.created_at)}</div>
      <div class="entry-body">
        <h3>${escapeHtml((e.data.context && e.data.context.type) || 'Erreur')}</h3>
        <p>${escapeHtml(e.data.message)}</p>
      </div>
      <div class="entry-actions"></div>
    </div>
  `).join('');
}

/* --- Rapport quotidien ------------------------------------------------------*/

async function generateReport() {
  const el = document.getElementById('reportPanel');
  el.innerHTML = emptyRow('Generation du rapport en cours...');
  try {
    const { rapport } = await api('/report/daily');
    el.innerHTML = `
      <h3 style="margin-top:0;font-family:var(--font-display);">RAPPORT QUOTIDIEN — ${escapeHtml(rapport.date)}</h3>
      <p style="font-size:12.5px;color:var(--parchment-dim);line-height:1.6;">
        Messages : ${rapport.messages.total_aujourdhui} · Prospects : ${rapport.prospects.total_aujourdhui} ·
        Ventes : ${rapport.ventes.total_aujourdhui} · Actions : ${rapport.actions_effectuees.total_aujourdhui} ·
        Erreurs : ${rapport.erreurs.total_aujourdhui} · Approbations en attente : ${rapport.approbations_en_attente}
      </p>
      <pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:11.5px;color:var(--parchment-dim);background:var(--ink);padding:10px;border-radius:3px;border:1px solid var(--line);max-height:340px;overflow:auto;">${escapeHtml(JSON.stringify(rapport, null, 2))}</pre>
    `;
    await loadDashboard();
  } catch (err) {
    el.innerHTML = emptyRow(`Erreur : ${err.message}`);
  }
}

/* --- Initialisation -----------------------------------------------------*/

function init() {
  populateTaskTypes();
  setOnboardingStep(1);
  document.querySelectorAll('[data-onboarding-step]').forEach((button) => {
    button.addEventListener('click', () => setOnboardingStep(button.dataset.onboardingStep));
  });
  document.getElementById('onboardingPrevBtn').addEventListener('click', () => setOnboardingStep(onboardingState.step - 1));
  document.getElementById('onboardingNextBtn').addEventListener('click', () => {
    if (onboardingState.step < 6) setOnboardingStep(onboardingState.step + 1);
    else document.getElementById('onboardingPanel').classList.add('collapsed');
  });
  document.querySelectorAll('.wizard-check-btn').forEach((button) => {
    button.addEventListener('click', () => checkOnboarding(button.dataset.onboardingCheck));
  });
  document.getElementById('onboardingHideBtn').addEventListener('click', (event) => {
    const panel = document.getElementById('onboardingPanel');
    panel.classList.toggle('collapsed');
    event.currentTarget.textContent = panel.classList.contains('collapsed') ? 'Afficher' : 'Masquer';
  });
  document.getElementById('apiKeyInput').value = apiKey();
  document.getElementById('saveKeyBtn').addEventListener('click', () => {
    localStorage.setItem(KEY_STORAGE, document.getElementById('apiKeyInput').value.trim());
    setFormMessage('apiKeyMsg', 'Clé enregistrée localement dans ce navigateur. Elle n’est jamais envoyée au serveur par cette action.', true);
  });
  document.getElementById('refreshApprovals').addEventListener('click', loadApprovals);
  document.getElementById('refreshTasks').addEventListener('click', loadTasks);
  document.getElementById('refreshProviders').addEventListener('click', loadProviders);
  document.getElementById('refreshConnectors').addEventListener('click', loadConnectors);
  document.getElementById('metaConnectBtn').addEventListener('click', startMetaOAuth);
  document.getElementById('metaTestBtn').addEventListener('click', testMetaConnection);
  document.getElementById('metaDisconnectBtn').addEventListener('click', disconnectMeta);
  document.getElementById('youtubeConnectBtn').addEventListener('click', startYoutubeOAuth);
  document.getElementById('youtubeTestBtn').addEventListener('click', testYoutubeConnection);
  document.getElementById('youtubeDisconnectBtn').addEventListener('click', disconnectYoutube);
  document.getElementById('tiktokConnectBtn').addEventListener('click', startTiktokOAuth);
  document.getElementById('tiktokTestBtn').addEventListener('click', testTiktokConnection);
  document.getElementById('tiktokReadBtn').addEventListener('click', readTiktokVideos);
  document.getElementById('tiktokDisconnectBtn').addEventListener('click', disconnectTiktok);
  document.getElementById('refreshTiktokPublicationsBtn')?.addEventListener('click', refreshAllTiktokPublicationStatuses);
  document.getElementById('runDiagnosticsBtn').addEventListener('click', runDiagnostics);
  document.getElementById('killSwitchToggleBtn').addEventListener('click', toggleKillSwitch);
  document.getElementById('launchTaskBtn').addEventListener('click', launchTask);
  document.getElementById('runVideoPipelineBtn')?.addEventListener('click', launchVideoPipeline);
  document.getElementById('refreshVideoReviewsBtn')?.addEventListener('click', loadDashboard);
  document.getElementById('createVideoJobBtn')?.addEventListener('click', createVideoJob);
  document.getElementById('refreshVideoJobsBtn')?.addEventListener('click', loadVideoJobs);
  document.getElementById('videoJobUseManifest')?.addEventListener('change', (e) => {
    const wrap = document.getElementById('videoJobManifestWrap');
    if (wrap) wrap.hidden = !e.target.checked;
  });
  loadVideoJobs();
  document.querySelectorAll('.mode-btn').forEach((button) => button.addEventListener('click', async () => {
    const requestedMode = button.dataset.mode;
    const currentMode = settingsState.settings?.mode || 'silencio';
    if (requestedMode === currentMode) return;
    const descriptions = {
      silencio: 'Calme et sécurisé : aucune action externe automatique ne pourra plus s’exécuter.',
      copilot: 'Le système analysera, préparera et proposera ; les actions importantes attendront votre validation.',
      conquistador: 'Autonomie encadrée par vos règles (plateformes, horaires, quotas, score qualité minimum). Le kill switch garde à tout moment la priorité absolue et peut tout arrêter immédiatement. L’autonomie réelle (publication sans validation humaine) reste en plus soumise à un réglage explicite séparé (campagne &gt; « approbation humaine requise » décoché).',
    };
    const bodyHtml = `
      <div class="modal-transition"><span>${escapeHtml(currentMode.toUpperCase())}</span><span class="arrow">→</span><span>${escapeHtml(requestedMode.toUpperCase())}</span></div>
      <p class="modal-body">${descriptions[requestedMode] || ''}</p>
      ${requestedMode === 'conquistador' ? '<p class="modal-note">Certaines actions peuvent encore nécessiter une approbation humaine selon vos paramètres de campagne.</p>' : ''}`;
    const confirmed = await showConfirmModal({
      eyebrow: 'Changement de mode',
      title: `Passer en mode ${requestedMode.toUpperCase()} ?`,
      bodyHtml,
      confirmLabel: 'Confirmer le changement',
      danger: requestedMode === 'conquistador',
    });
    if (!confirmed) return;
    // Le theme/badge/etat affiche ne changent QUE si cet appel reussit
    // reellement (voir changeMode -> renderSettings -> applyConfirmedMode) :
    // aucune mutation optimiste du DOM avant reponse serveur.
    await changeMode(requestedMode, button);
  }));
  document.getElementById('refreshSettingsBtn')?.addEventListener('click', loadSettings);
  document.getElementById('saveSettingsBtn')?.addEventListener('click', saveSettings);
  document.getElementById('refreshKnowledgeBtn')?.addEventListener('click', loadKnowledge);
  document.getElementById('addKnowledgeBtn')?.addEventListener('click', addKnowledge);
  document.getElementById('refreshVoiceHealthBtn')?.addEventListener('click', loadVoiceHealth);
  document.getElementById('generateVoiceBtn')?.addEventListener('click', generateVoice);
  document.getElementById('runCommercialBtn')?.addEventListener('click', runCommercial);
  document.getElementById('prepareFollowupBtn')?.addEventListener('click', prepareCommercialFollowup);
  document.getElementById('generateReportBtn').addEventListener('click', generateReport);
  document.getElementById('refreshObjectivesBtn')?.addEventListener('click', loadObjectivesAndProgress);
  document.getElementById('saveObjectivesBtn')?.addEventListener('click', saveObjectives);
  document.querySelectorAll('.period-btn[data-granularite]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.period-btn[data-granularite]').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    periodState.granularite = button.dataset.granularite;
    periodState.offset = 0;
    loadPeriodComparison();
  }));
  document.getElementById('periodOlderBtn')?.addEventListener('click', () => {
    periodState.offset += 1;
    loadPeriodComparison();
  });
  document.getElementById('periodNewerBtn')?.addEventListener('click', () => {
    if (periodState.offset === 0) return;
    periodState.offset -= 1;
    loadPeriodComparison();
  });

  loadHealth();
  loadApprovals();
  loadTasks();
  loadDashboard();
  loadProviders();
  loadConnectors();
  loadKillSwitch();
  loadSettings();
  loadKnowledge();
  loadVoiceHealth();
  initViewRouter();
  initSearch();
  document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
    const isOpen = document.getElementById('sidebar').classList.contains('open');
    if (isOpen) closeSidebarMobile(); else openSidebarMobile();
  });
  document.getElementById('scrim').addEventListener('click', () => { closeSidebarMobile(); toggleNotifPanel(false); });
  document.getElementById('notifBtn').addEventListener('click', () => toggleNotifPanel());
  document.getElementById('notifCloseBtn').addEventListener('click', () => toggleNotifPanel(false));
  const params = new URLSearchParams(window.location.search);
  const metaResult = params.get('meta');
  if (metaResult === 'connected') setMetaActionMessage('Connexion Meta terminée. Vérifiez les tokens et les capacités.', true);
  if (metaResult === 'error') setMetaActionMessage('La connexion Meta a échoué. Consultez le diagnostic.', false);
  const youtubeResult = params.get('youtube');
  if (youtubeResult === 'connected') setYoutubeActionMessage('Connexion YouTube terminée. Vérifiez la chaîne et les capacités.', true);
  if (youtubeResult === 'error') setYoutubeActionMessage('La connexion YouTube a échoué. Consultez le diagnostic.', false);
  const tiktokResult = params.get('tiktok');
  if (tiktokResult === 'connected') setTiktokActionMessage('Connexion TikTok terminée. Vérifiez le compte et les capacités.', true);
  if (tiktokResult === 'error') setTiktokActionMessage('La connexion TikTok a échoué. Consultez le diagnostic.', false);

  setInterval(loadHealth, 30000);
  // Resynchronisation periodique de la source de verite (mode/campagne) :
  // couvre le cas ou l'etat reel a change ailleurs (autre onglet, autre
  // appareil, script planifie) pendant que cette page reste ouverte. Ne
  // touche jamais le DOM avant reponse serveur (voir renderSettings ->
  // applyConfirmedMode).
  setInterval(loadSettings, 45000);
}

document.addEventListener('DOMContentLoaded', init);
