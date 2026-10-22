// @ts-check
/**
 * 🚀 Punto de entrada del frontend (ES Modules nativos)
 */

import { $, $$ } from './utils.js';
import { getStatus } from './api.js';
import { initDashboardTab, renderDashboard, renderDashboardError } from './tabs/dashboard.js';
import { initWhatsAppTab, onWhatsAppTabOpen, refreshSession, refreshPairingState } from './tabs/whatsapp.js';
import { initContactsTab, resetContactList } from './tabs/contacts.js';
import { initProfilesTab, loadProfiles } from './tabs/profiles.js';
import { initLogsTab, onLogsTabOpen } from './tabs/logs.js';
import { initTelegramTab, loadTgSettings } from './tabs/telegram.js';

const livedot = $('#livedot');
const livetext = $('#livetext');

let currentPage = 'dashboard';

const pages = {
  dashboard: 'page-dashboard',
  pairing: 'page-pairing',
  contactos: 'page-contactos',
  perfiles: 'page-perfiles',
  logs: 'page-logs',
  integrations: 'page-integrations'
};

export function showPage(name) {
  if (!pages[name]) name = 'dashboard';
  currentPage = name;

  for (const p of Object.keys(pages)) {
    const el = document.getElementById(pages[p]);
    if (el) el.hidden = p !== name;
    const tabEl = $('.nav .tab[data-page="' + p + '"]');
    if (tabEl) tabEl.classList.toggle('on', p === name);
  }

  if (name === 'pairing') onWhatsAppTabOpen();
  if (name === 'contactos') resetContactList();
  if (name === 'perfiles') loadProfiles();
  if (name === 'logs') onLogsTabOpen();
  if (name === 'integrations') loadTgSettings();

  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}

async function refresh() {
  try {
    const d = await getStatus();
    renderDashboard(d);
    livedot.className = 'dot';
    livetext.textContent = 'en vivo · ' + new Date().toLocaleTimeString();
  } catch (e) {
    renderDashboardError(e);
    livedot.className = 'dot dead';
    livetext.textContent = 'desconectado del gateway';
  }
}

// Inicialización general
function init() {
  // Inicializar pestañas
  initDashboardTab(refresh);
  initWhatsAppTab();
  initContactsTab();
  initProfilesTab();
  initLogsTab();
  initTelegramTab();

  // Navegación
  $$('.nav .tab').forEach(t => {
    t.addEventListener('click', () => {
      const target = /** @type {HTMLElement} */ (t);
      if (target.dataset.page) showPage(target.dataset.page);
    });
  });

  window.addEventListener('hashchange', () => {
    showPage(location.hash.replace('#', ''));
  });

  // Polling de dashboard (cada 10s)
  refresh();
  setInterval(refresh, 10000);

  // Polling auxiliar de pairing (cada 15s) cuando la pestaña está activa
  setInterval(() => {
    if (currentPage === 'pairing') {
      refreshSession();
      refreshPairingState();
    }
  }, 15000);

  // Abrir la pestaña inicial según el hash
  showPage((location.hash || '').replace('#', ''));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
