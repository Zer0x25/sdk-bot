// @ts-check
/**
 * 📊 Pestaña Dashboard: Tarjetas de métricas del sistema y terminal de comandos
 */

import { $, esc, fmt, mem, age, trunc, splitProvider, channelState, brainStateClass } from '../utils.js';
import { sendCommand, startBrain } from '../api.js';

let lastStatus = null;
const cards = $('#cards');
const out = $('#out');
const cmd = /** @type {HTMLInputElement} */ ($('#cmd'));
const run = /** @type {HTMLButtonElement} */ ($('#run'));

function card(title, lines) {
  return '<div class="card"><h2>' + title + '</h2>' + lines.map(([k, v, cls]) =>
    '<div class="row"><span>' + k + '</span><span class="' + (cls || '') + '">' + v + '</span></div>'
  ).join('') + '</div>';
}

export function renderDashboard(d) {
  lastStatus = d;
  const channels = d.channels || {};
  const wa = channels.whatsapp || {};
  const tg = channels.telegram || {};
  const brain = d.brain || {};
  const bh = brain.health || {};
  const paused = d.bot && d.bot.paused;
  const contactStates = (d.database && d.database.byState) || {};
  const broadcast = d.broadcast || {};
  const queue = d.queue || {};
  const brainMemory = (bh.health && bh.health.memory) || {};
  const waSt = channelState(wa);
  const tgSt = channelState(tg);
  const phone = d.bot && (d.bot.number || d.bot.lid);
  const phoneFormatted = phone ? (String(phone).startsWith('+') ? String(phone) : '+' + phone) : '—';

  cards.innerHTML =
    card('Gateway (Core)', [
      ['uptime', Math.round(d.uptime_seconds / 60) + ' min'],
      ['versión node', d.node || '-'],
      ['memoria RAM', Math.round((d.memory?.rss || 0) / 1024 / 1024) + ' MB']
    ]) +
    card('Canales (Adapters)', [
      ['WhatsApp', waSt.label, waSt.cls],
      ['wa reconexión', '#' + (wa.reconnectAttempt ?? 0)],
      ['Telegram', tgSt.label, tgSt.cls],
      ['teléfono admin', phoneFormatted]
    ]) +
    card('Brain', [
      ['estado', bh.state || 'desconocido', brainStateClass(bh.state)],
      ...(() => {
        const p = splitProvider((bh.health && bh.health.providers && bh.health.providers.primary) || '');
        return [['proveedor', trunc(p.provider, 32)], ['modelo', trunc(p.model, 32)]];
      })(),
      ['uptime', bh.health ? Math.round(bh.health.uptime_seconds / 60) + ' min' : '-'],
      ['llamadas IA', fmt(brain.aiCalls)],
      ['último error', trunc(brain.lastErrorMsg || bh.lastError || '—', 32)]
    ]) +
    (bh.state === 'Stopped' || !bh.reachable ? '<button class="btn-toggle" id="brainStart">⚡ Encender brain</button>' : '') +
    card('Bot', [
      ['estado', paused ? 'Pausado' : 'Activo', paused ? 'warn' : 'ok'],
      ['número', (d.bot && d.bot.number) || '-'],
      ['perfil', (d.bot && d.bot.profile) || '-'],
      ['modo', (d.bot && d.bot.globalMode) || '-']
    ]) +
    '<button class="btn-toggle" id="botToggle">' + (paused ? '▶ Reanudar' : '⏸ Pausar') + '</button>' +
    card('Contactos', [
      ['estado', (d.database && d.database.globalMode === 'ignored_all') ? 'Ignore_All' : 'Access_All',
        (d.database && d.database.globalMode === 'ignored_all') ? 'warn' : 'ok'],
      ['agenda', fmt(d.database && d.database.contacts)],
      ['permitidos', fmt(contactStates.permitido)],
      ['ignorados', fmt(contactStates.ignorado)],
      ['handoff', fmt(contactStates.handoff)],
      ['modo global', (d.database && d.database.globalMode) || '-'],
      ['perfil global', (d.database && d.database.currentProfile) || '-']
    ]) +
    card('Broadcast', [
      ['estado', broadcast.enabled ? 'ACTIVADO' : 'desactivado', broadcast.enabled ? 'ok' : 'warn'],
      ['pendientes', fmt(broadcast.pending)],
      ['enviando', fmt(broadcast.sending)],
      ['total', fmt(broadcast.total)],
      ['límite diario', broadcast.dailyLimit]
    ]) +
    card('Cola', [
      ['mensajes', fmt(queue.pending) + ' / ' + fmt(queue.max)],
      ['más antiguo', age(queue.oldestAt)]
    ]) +
    card('Memoria', [
      ['RSS', mem(d.memory && d.memory.rss)],
      ['heap', mem(d.memory && d.memory.heapUsed) + ' / ' + mem(d.memory && d.memory.heapTotal)],
      ['mensajes', fmt(brainMemory.messages)],
      ['chats', fmt(brainMemory.chats)],
      ['DB', mem(brainMemory.size_bytes)]
    ]);
}

export function renderDashboardError(err) {
  cards.innerHTML = '<div class="card"><h2>Panel</h2><div class="row"><span>error</span><span class="bad">' + esc(err.message) + '</span></div></div>';
}

async function toggleBot() {
  if (!lastStatus) return;
  const pausado = !!(lastStatus.bot && lastStatus.bot.paused);
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('botToggle'));
  if (btn) btn.disabled = true;
  try {
    await sendCommand(pausado ? '/reanudar' : '/pausar');
  } finally {
    const b2 = /** @type {HTMLButtonElement} */ (document.getElementById('botToggle'));
    if (b2) b2.disabled = false;
  }
}

async function triggerStartBrain() {
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('brainStart'));
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Encendiendo…'; }
  try {
    const d = await startBrain();
    alert(d.message || (d.success ? 'Brain encendiéndose…' : 'No se pudo encender el brain'));
  } catch (e) {
    alert('Error al encender el brain: ' + e.message);
  }
}

async function runCmd() {
  const text = cmd.value.trim();
  if (!text) return;
  run.disabled = true;
  const block = document.createElement('div');
  block.className = 'out-block';
  block.innerHTML = '<span class="out-cmd">$ ' + esc(text) + '</span>';
  out.prepend(block);
  const status = document.createElement('div');
  status.textContent = 'Ejecutando…';
  block.appendChild(status);
  try {
    const d = await sendCommand(text);
    status.remove();
    for (const rep of (d.replies || [])) {
      const el = document.createElement('div');
      if (rep.type === 'document') {
        el.innerHTML = '<a href="data:application/octet-stream;base64,' + rep.base64 +
          '" download="' + esc(rep.fileName || 'archivo') + '">📄 Descargar ' + esc(rep.fileName || 'archivo') + '</a>' +
          (rep.caption ? '<br><i>' + esc(rep.caption) + '</i>' : '');
      } else {
        el.textContent = rep.text || JSON.stringify(rep);
      }
      block.appendChild(el);
    }
    if (!d.replies || !d.replies.length) {
      block.appendChild(document.createTextNode('(sin respuesta)'));
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  } finally {
    run.disabled = false;
    cmd.value = '';
    cmd.focus();
  }
}

export function initDashboardTab(onRefreshRequest) {
  cards.addEventListener('click', async e => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target && target.id === 'botToggle') {
      await toggleBot();
      if (typeof onRefreshRequest === 'function') onRefreshRequest();
    }
    if (target && target.id === 'brainStart') {
      await triggerStartBrain();
      if (typeof onRefreshRequest === 'function') onRefreshRequest();
    }
  });

  run.addEventListener('click', runCmd);
  cmd.addEventListener('keydown', e => { if (e.key === 'Enter') runCmd(); });
}
