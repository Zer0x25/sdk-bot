// @ts-check
/**
 * 📜 Pestaña Logs: Transmisión SSE en vivo de logs de Gateway y Brain, filtrado y pausa
 */

import { $ } from '../utils.js';
import { clearLogs as apiClearLogs } from '../api.js';

const logbox = $('#logbox');
const lstatus = $('#lstatus');
const lvl = /** @type {HTMLSelectElement} */ ($('#lvl'));
const ltg = $('#ltg');
const lbr = $('#lbr');
const lplay = /** @type {HTMLButtonElement} */ ($('#lplay'));
const lclear = /** @type {HTMLButtonElement} */ ($('#lclear'));

let es = null;
let logComp = 'gateway';
let paused = false;
let logLines = 0;

function pinoLevel(n) {
  if (n >= 50) return 'error';
  if (n >= 40) return 'warn';
  if (n >= 30) return 'info';
  return 'debug';
}

function pythonLevel(s) {
  const m = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|CRITICAL)\b/.exec(s);
  return m ? m[1].toLowerCase().replace('warning', 'warn') : 'info';
}

function acceptsLevel(lv) {
  const want = lvl.value;
  if (want === 'all') return true;
  const rank = { debug: 0, info: 1, warn: 2, error: 3 };
  return (want === 'error') ? lv === 'error' : rank[lv] >= rank[want];
}

function appendLine(d) {
  const row = document.createElement('div');
  row.className = 'log-line';
  let lv = 'info', time = '', cat = '', msg = String(d.line).replace(/\s+$/, '');
  if (logComp === 'gateway' && d.line.startsWith('{')) {
    try {
      const j = JSON.parse(d.line);
      lv = pinoLevel(j.level);
      time = (j.time ? new Date(j.time) : new Date()).toLocaleTimeString('es-CL', { hour12: false });
      cat = j.cat || '';
      msg = j.msg || '';
    } catch { /* línea no JSON: se muestra cruda */ }
  } else {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d+)?)\s+(\w+)\s+(?:\[([^\]]+)\]\s+)?(.*)$/.exec(msg);
    if (m) { time = m[1].slice(11); lv = pythonLevel(m[2]); cat = m[3] || ''; msg = m[4]; }
  }
  if (!acceptsLevel(lv)) return;
  const head = document.createElement('div');
  head.className = 'log-head';
  const tm = document.createElement('span');
  tm.className = 'log-time'; tm.textContent = time || new Date().toLocaleTimeString('es-CL', { hour12: false });
  const ca = document.createElement('span');
  ca.className = 'log-cat'; ca.textContent = cat ? '[' + cat + ']' : '';
  head.append(tm, ca);
  const mg = document.createElement('div');
  mg.className = 'log-msg lv-' + lv; mg.textContent = msg;
  row.append(head, mg);
  const stick = logbox.scrollTop + logbox.clientHeight >= logbox.scrollHeight - 40;
  logbox.appendChild(row);
  logLines++;
  while (logLines > 800) { logbox.firstChild.remove(); logLines--; }
  if (stick) logbox.scrollTop = logbox.scrollHeight;
}

export function startLogs() {
  if (es) es.close();
  logbox.innerHTML = '';
  logLines = 0;
  lstatus.textContent = 'conectando…';
  es = new EventSource('/api/logs?component=' + logComp + '&history=100');
  const tabOn = logComp === 'gateway' ? ltg : lbr, tabOff = logComp === 'gateway' ? lbr : ltg;
  tabOn.classList.add('on'); tabOff.classList.remove('on');
  es.onmessage = e => {
    lstatus.textContent = 'en vivo';
    if (!paused) appendLine(JSON.parse(e.data));
  };
  es.onerror = () => { lstatus.textContent = 'conexión perdida — reintentando…'; };
}

export function onLogsTabOpen() {
  if (!paused) startLogs();
}

export function initLogsTab() {
  ltg.addEventListener('click', () => { if (logComp !== 'gateway') { logComp = 'gateway'; startLogs(); } });
  lbr.addEventListener('click', () => { if (logComp !== 'brain') { logComp = 'brain'; startLogs(); } });
  lplay.addEventListener('click', () => {
    paused = !paused;
    lplay.textContent = paused ? '▶️ Reanudar' : '⏸️ Pausar';
    if (!paused) startLogs();
  });
  lclear.addEventListener('click', async () => {
    if (!confirm('¿Limpiar el historial de logs de ' + (logComp === 'brain' ? 'Brain' : 'Gateway') + '? (solo el archivo activo, no los rotados)')) return;
    try {
      const j = await apiClearLogs(logComp);
      if (!j.success) { lstatus.textContent = 'Error: ' + (j.message || 'sin detalle'); return; }
      logbox.innerHTML = ''; logLines = 0;
      if (!paused) startLogs();
      lstatus.textContent = 'Historial limpiado';
    } catch (e) { lstatus.textContent = 'Error: ' + e.message; }
  });
}
