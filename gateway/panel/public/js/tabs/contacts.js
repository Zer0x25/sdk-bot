// @ts-check
/**
 * 📇 Pestaña Contactos: Agenda de contactos, búsqueda en vivo, scroll infinito y edición de estados/perfiles
 */

import { $, esc } from '../utils.js';
import { getContacts, setContactState as apiSetContactState, setContactProfile as apiSetContactProfile, getProfiles } from '../api.js';

const cq = /** @type {HTMLInputElement} */ ($('#cq'));
const ce = /** @type {HTMLSelectElement} */ ($('#ce'));
const ctotal = $('#ctotal');
const ctb = $('#contacts tbody');
const cList = $('#cList');
const csentry = $('#csentry');
const cclear = $('#cclear');

const badge = { neutro: 'b-neutro', permitido: 'b-permitido', ignorado: 'b-ignorado', handoff: 'b-handoff' };

let cState = { page: 1, limit: 50, q: '', estado: '' };
let cLoading = false;
let cDone = false;
let allProfilesCache = [];
let cSearchTimer = null;

async function fetchProfilesCache() {
  try {
    const d = await getProfiles();
    allProfilesCache = Array.isArray(d.profiles) ? d.profiles : [];
  } catch {
    allProfilesCache = [];
  }
  return allProfilesCache;
}

function buildProfileSelect(c) {
  if (!c.isContact) return esc(c.perfil || '—');
  const current = (c.perfil && c.perfil !== 'default') ? c.perfil : 'default';
  let opts = '<option value="default"' + (current === 'default' ? ' selected' : '') + '>Por defecto (default)</option>';
  for (const p of allProfilesCache) {
    const key = typeof p === 'string' ? p : (p && p.key);
    if (!key || key === 'default') continue;
    const nombre = (typeof p === 'object' && p && p.nombre) ? p.nombre : key;
    opts += '<option value="' + esc(key) + '"' + (current === key ? ' selected' : '') + '>' + esc(nombre + ' (' + key + ')') + '</option>';
  }
  if (current !== 'default' && !allProfilesCache.some(p => (typeof p === 'string' ? p : (p && p.key)) === current)) {
    opts += '<option value="' + esc(current) + '" selected>' + esc(current) + '</option>';
  }
  return '<select data-key="' + esc(c.key) + '" data-kind="perfil">' + opts + '</select>';
}

export function resetContactList() {
  cState.page = 1;
  cDone = false;
  cLoading = false;
  ctb.innerHTML = '';
  csentry.textContent = 'Cargando…';
  loadMore();
}

async function loadMore() {
  if (cLoading || cDone) return;
  cLoading = true;
  try {
    if (!allProfilesCache.length) await fetchProfilesCache().catch(() => {});
    const d = await getContacts({
      q: cState.q,
      estado: cState.estado,
      page: cState.page,
      limit: cState.limit
    });
    const totalNumEl = ctotal.querySelector('#ctotal-num');
    if (totalNumEl) totalNumEl.textContent = d.total ?? 0;

    for (const c of (d.contacts || [])) {
      const tr = document.createElement('tr');
      const cls = badge[c.estado] || badge.neutro;
      const perfilHtml = buildProfileSelect(c);
      tr.innerHTML = '<td>' + esc(c.savedName || '—') + '</td><td>' + esc(c.phone || '—') + '</td><td class="col-lid">' + esc(c.lid || '—') +
        '</td><td><span class="badge ' + cls + '">' + esc(c.estado || 'neutro') + '</span></td><td>' + perfilHtml + '</td>' +
        '<td><div class="chips">' +
        (c.estado !== 'permitido' ? '<button data-key="' + esc(c.key) + '" data-act="permitir">Permitir</button>' : '') +
        (c.estado !== 'ignorado' ? '<button data-key="' + esc(c.key) + '" data-act="ignorar">Ignorar</button>' : '') +
        (c.estado !== 'neutro' ? '<button data-key="' + esc(c.key) + '" data-act="neutro">Neutro</button>' : '') +
        '</div></td>';
      ctb.appendChild(tr);
    }
    cState.page++;
    if (!d.contacts || d.contacts.length < cState.limit) {
      cDone = true;
      csentry.textContent = d.total ? '— fin de la lista —' : (cState.q || cState.estado ? 'Sin resultados para el filtro actual.' : 'Sin contactos todavía.');
    }
  } catch (e) {
    cDone = true;
    csentry.textContent = 'Error: ' + e.message;
  } finally {
    cLoading = false;
  }
}

function updateRowState(tr, key, estado) {
  const badgeSpan = tr.querySelector('td:nth-child(4) .badge');
  if (badgeSpan) {
    badgeSpan.className = 'badge ' + (badge[estado] || badge.neutro);
    badgeSpan.textContent = estado;
  }
  const chipsDiv = tr.querySelector('td:nth-child(6) .chips');
  if (chipsDiv) {
    chipsDiv.innerHTML =
      (estado !== 'permitido' ? '<button data-key="' + esc(key) + '" data-act="permitir">Permitir</button>' : '') +
      (estado !== 'ignorado' ? '<button data-key="' + esc(key) + '" data-act="ignorar">Ignorar</button>' : '') +
      (estado !== 'neutro' ? '<button data-key="' + esc(key) + '" data-act="neutro">Neutro</button>' : '');
  }
}

async function handleSetContactState(key, estado, btn) {
  if (btn) btn.disabled = true;
  try {
    const d = await apiSetContactState(key, estado);
    if (!d.success) {
      alert('⚠️ ' + (d.message || 'Error al cambiar estado'));
      if (btn) btn.disabled = false;
      return;
    }
    const realState = d.state || (estado === 'permitir' ? 'permitido' : (estado === 'ignorar' ? 'ignorado' : 'neutro'));
    const tr = btn ? btn.closest('tr') : null;
    if (tr) {
      updateRowState(tr, key, realState);
    } else {
      resetContactList();
    }
  } catch (e) {
    alert('⚠️ Error de conexión: ' + e.message);
    if (btn) btn.disabled = false;
  }
}

export function initContactsTab() {
  const cObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadMore();
  }, { root: cList, rootMargin: '250px' });
  cObserver.observe(csentry);

  ctb.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);
    const btn = target.closest('button[data-act]');
    if (btn) {
      const buttonEl = /** @type {HTMLButtonElement} */ (btn);
      handleSetContactState(buttonEl.dataset.key, buttonEl.dataset.act, buttonEl);
    }
  });

  ctb.addEventListener('change', async e => {
    const target = /** @type {HTMLElement} */ (e.target);
    const sel = /** @type {HTMLSelectElement} */ (target.closest('select[data-kind="perfil"]'));
    if (!sel) return;
    const key = sel.dataset.key;
    const perfil = sel.value;
    sel.disabled = true;
    try {
      const d = await apiSetContactProfile(key, perfil);
      sel.disabled = false;
      if (!d.success) {
        alert('⚠️ ' + (d.message || 'Error al asignar perfil'));
      }
    } catch (err) {
      sel.disabled = false;
      alert('⚠️ Error de conexión: ' + err.message);
    }
  });

  cq.addEventListener('input', () => {
    cclear.hidden = !cq.value;
    clearTimeout(cSearchTimer);
    cSearchTimer = setTimeout(() => {
      const q = cq.value.trim();
      if (q === cState.q && ce.value === cState.estado) return;
      cState.q = q;
      resetContactList();
    }, 300);
  });

  cclear.addEventListener('click', () => {
    clearTimeout(cSearchTimer);
    cq.value = '';
    cclear.hidden = true;
    if (cState.q) {
      cState.q = '';
      resetContactList();
    }
    cq.focus();
  });

  cq.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    clearTimeout(cSearchTimer);
    const q = cq.value.trim();
    if (q === cState.q && ce.value === cState.estado) return;
    cState.q = q;
    resetContactList();
  });

  ce.addEventListener('change', () => {
    cState.estado = ce.value;
    resetContactList();
  });
}
