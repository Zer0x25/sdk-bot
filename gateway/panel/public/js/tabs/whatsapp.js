// @ts-check
/**
 * 📲 Pestaña WhatsApp: Pairing por QR / Número, Reset de sesión y Reset limpio de fábrica (F7)
 */

import { $ } from '../utils.js';
import { getStatus, getPairingStatus, refreshQr, requestPairingCode, resetSession, resetCleanFactory } from '../api.js';

const noview = $('#noview'), connview = $('#connview'), connnum = $('#connnum');
const pairChoice = $('#pair-choice'), methodBack = $('#method-back');
const pairmodeQr = $('#pairmode-qr'), pairmodeNum = $('#pairmode-num');
const qrbox = $('#qrbox'), qrst = $('#qrst');
const pairphone = /** @type {HTMLInputElement} */ ($('#pairphone'));
const pairbtn = /** @type {HTMLButtonElement} */ ($('#pairbtn'));
const pairmsg2 = $('#pairmsg2');
const paircodecard = $('#paircodecard'), paircode = $('#paircode');
const paircodeage = $('#paircodeage');
const copycode = /** @type {HTMLButtonElement} */ ($('#copycode'));
const genqrbtn = /** @type {HTMLButtonElement} */ ($('#genqrbtn'));
const pairmsg = $('#pairmsg');
const resetbtn = /** @type {HTMLButtonElement} */ ($('#resetbtn'));
const resetmsg = $('#resetmsg');
const cleanbtn = /** @type {HTMLButtonElement} */ ($('#cleanbtn'));
const cleanmsg = $('#cleanmsg');

const QR_BADGE = '<div class="noqr"><svg viewBox="0 0 100 100" width="84" height="84" aria-hidden="true">' +
  '<circle cx="50" cy="50" r="43" fill="none" stroke="#dc2626" stroke-width="9"/>' +
  '<line x1="17" y1="17" x2="83" y2="83" stroke="#dc2626" stroke-width="9" stroke-linecap="round"/>' +
  '</svg></div>';

let qrExpiresAt = 0;
let qrTimerStartedAt = 0;
let qrTimer = null;
let pairingInProgress = false;
let qrFeedStarted = false;
let qrEs = null;
let sessionNumber = '';
// Antigüedad del código de enlace (rotación aproximada informada por el bus)
let codeExpiresAt = 0;
let codeAgeTimer = null;

export function setSession(open, number) {
  if (number) sessionNumber = number;
  noview.hidden = open;
  connview.hidden = !open;
  if (open) {
    connnum.textContent = sessionNumber || '—';
    resetmsg.className = '';
  }
}

export async function refreshSession() {
  try {
    const d = await getStatus();
    const isOpen = !!(d.channels && d.channels.whatsapp && d.channels.whatsapp.connection === 'open');
    setSession(isOpen, (d.bot && d.bot.number) || '');
  } catch (e) { /* reintenta en el próximo tick */ }
}

export async function refreshPairingState() {
  try {
    const d = await getPairingStatus();
    if (!d.active) return;
    if (d.method === 'qr') {
      showPairMode('qr', true);
      if (d.expiresAt) {
        qrExpiresAt = d.expiresAt;
        qrTimerStartedAt = d.issuedAt || Date.now();
        startQrTimer();
      }
      if (d.busy) {
        pairingInProgress = true;
        qrbox.innerHTML = '<div class="empty">⏳ <span>Generando código QR…</span></div>';
        qrst.textContent = 'Conectando con WhatsApp para obtener un QR fresco…';
      }
    } else if (d.method === 'code') {
      showPairMode('num', true);
      if (d.code) {
        renderPairingCode(d.code, d.issuedAt, d.expiresAt);
      } else {
        pairingInProgress = true;
        pairbtn.disabled = true;
        pairbtn.textContent = '⏳ Solicitando…';
        pairmsg2.textContent = 'Solicitando código de enlace…';
      }
    }
  } catch (e) { /* reintenta en el próximo tick */ }
}

function showPairMode(mode, restoring = false) {
  pairChoice.hidden = true;
  methodBack.hidden = false;
  pairmodeQr.hidden = mode !== 'qr';
  pairmodeNum.hidden = mode !== 'num';
  if (mode !== 'num') paircodecard.hidden = true;
  if (mode === 'qr') {
    if (!qrFeedStarted) { qrFeedStarted = true; startQrFeed(); }
    else if (qrEs && qrEs.readyState === EventSource.CLOSED) { startQrFeed(); }
    if (!restoring && !(qrExpiresAt > Date.now())) {
      refreshQrFromServer();
    }
  }
  refreshSession();
}

function renderQrState(d) {
  if (d && d.qr) {
    pairingInProgress = false;
    stopQrTimer();
    qrExpiresAt = d.expiresAt || 0;
    qrTimerStartedAt = d.issuedAt || Date.now();
    qrbox.innerHTML = '<img src="' + d.qr + '" alt="Código QR de WhatsApp">';
    qrst.className = 'ok';
    qrst.textContent = 'Escanea el QR con WhatsApp > Dispositivos vinculados > Vincular dispositivo.';
    startQrTimer();
  } else {
    stopQrTimer();
    qrTimerStartedAt = 0;
    const exp = !!(d && d.expired);
    if (pairingInProgress) {
      qrbox.innerHTML = '<div class="empty">⏳ <span>Generando código QR…</span></div>';
      qrst.className = '';
      qrst.textContent = 'Conectando con WhatsApp para obtener un QR fresco…';
      genqrbtn.disabled = true;
      genqrbtn.textContent = '⏳ Generando…';
    } else {
      qrbox.innerHTML = '<div class="empty">' + QR_BADGE + '<span>' + (exp ? 'QR expirado' : 'QR no disponible') + '</span></div>';
      qrst.className = exp ? 'warn' : '';
      qrst.textContent = exp ? 'El QR expiró (2 min 20 s sin escanear). Puedes generar otro.' : 'Genera un QR para vincular (válido 2 min 20 s).';
      genqrbtn.disabled = false;
      genqrbtn.textContent = '🔄 Generar QR';
    }
  }
}

function startQrTimer() {
  stopQrTimer();
  qrTimer = setInterval(() => {
    const remain = qrExpiresAt - Date.now();
    if (remain <= 0) {
      renderQrState({ qr: null, expired: true });
      return;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - qrTimerStartedAt) / 1000));
    genqrbtn.disabled = true;
    genqrbtn.textContent = '⏱️ QR válido: ' + elapsed + 's';
  }, 500);
}

function stopQrTimer() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
}

async function refreshQrFromServer() {
  if (pairingInProgress) return;
  pairingInProgress = true;
  genqrbtn.disabled = true;
  genqrbtn.textContent = '⏳ Generando…';
  qrbox.innerHTML = '<div class="empty">⏳ <span>Generando código QR…</span></div>';
  qrst.className = '';
  qrst.textContent = 'Conectando con WhatsApp para obtener un QR fresco…';
  try {
    const d = await refreshQr();
    if (d.success) {
      pairmsg.className = 'ok';
      pairmsg.textContent = '✅ ' + (d.message || 'QR regenerado — escanea el que aparezca.');
    } else {
      if (d.method === 'code') {
        showPairMode('num', true);
        if (d.code) renderPairingCode(d.code, d.issuedAt, d.expiresAt);
        return;
      }
      pairmsg.className = 'err';
      pairmsg.textContent = '⚠️ ' + (d.message || 'No se pudo generar el QR');
      if (!d.busy) {
        pairingInProgress = false;
        if (d.expiresAt) {
          qrTimerStartedAt = d.issuedAt || Date.now();
          qrExpiresAt = d.expiresAt;
          startQrTimer();
        }
        if (!(qrExpiresAt > Date.now())) {
          genqrbtn.disabled = false;
          genqrbtn.textContent = '🔄 Generar QR';
        }
      }
    }
  } catch (e) {
    pairmsg.className = 'err';
    pairmsg.textContent = '⚠️ Error: ' + e.message;
    pairingInProgress = false;
    if (!(qrExpiresAt > Date.now())) {
      genqrbtn.disabled = false;
      genqrbtn.textContent = '🔄 Generar QR';
    }
  }
  // Fallback por si el SSE no llega (el backend mantiene el bloqueo real
  // ~10s mientras recrea el socket; dar un margen extra antes de rendir).
  setTimeout(() => {
    if (pairingInProgress && !(qrExpiresAt > Date.now())) {
      pairingInProgress = false;
      genqrbtn.disabled = false;
      genqrbtn.textContent = '🔄 Generar QR';
      renderQrState({ qr: null, expired: false });
      qrst.textContent = 'Sigue sin aparecer el QR: revisa la conexión y genera otro.';
    }
  }, 12000);
}

function startQrFeed() {
  if (qrEs) { try { qrEs.close(); } catch (e) {} }
  qrEs = new EventSource('/api/qr');
  qrEs.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.session !== undefined) setSession(!!d.session, '');
      renderQrState(d);
    } catch (err) { /* evento inválido */ }
  };
  qrEs.onopen = () => {};
  qrEs.onerror = () => { /* el EventSource reintenta solo */ };
}

function renderPairingCode(code, issuedAt, expiresAt) {
  paircode.textContent = String(code).trim();
  paircodecard.hidden = false;
  pairmsg2.className = 'ok';
  pairmsg2.textContent = '✅ Código listo. Ábrelo en WhatsApp (Dispositivos vinculados > Vincular con número de teléfono) e ingresa la ficha que te muestre aquí.';
  pairingInProgress = false;
  pairbtn.disabled = false;
  pairbtn.textContent = '🔄 Solicitar otro código';
  // Antigüedad del código: WhatsApp rota estos códigos al poco de emitirlos;
  // avisamos para que el admin sepa cuándo pedir otro sin adivinar.
  codeExpiresAt = Number(expiresAt) || (Number(issuedAt) ? Number(issuedAt) + 180000 : 0);
  startCodeAgeTicker();
}

function startCodeAgeTicker() {
  stopCodeAgeTicker();
  updateCodeAge();
  codeAgeTimer = setInterval(updateCodeAge, 1000);
}

function stopCodeAgeTicker() {
  if (codeAgeTimer) { clearInterval(codeAgeTimer); codeAgeTimer = null; }
}

function updateCodeAge() {
  if (!paircodeage) return;
  if (!codeExpiresAt || paircodecard.hidden) {
    paircodeage.hidden = true;
    stopCodeAgeTicker();
    return;
  }
  const remain = Math.ceil((codeExpiresAt - Date.now()) / 1000);
  paircodeage.hidden = false;
  if (remain > 0) {
    paircodeage.style.color = '';
    paircodeage.textContent = '⏱️ Si el código es rechazado, solicita otro (rotación en ~' + Math.max(remain, 0) + 's).';
  } else {
    paircodeage.style.color = '#facc15';
    paircodeage.textContent = '⚠️ Este código probablemente ya expiró: pulsa «Solicitar otro código».';
  }
}

// 🧨 F7: Modal de reset de fábrica
const cleanModal = $('#cleanmodal'), cleanread = $('#cleanread'), cleanreadn = $('#cleanreadn');
const cleanwrite = $('#cleanwrite'), cleanwriten = $('#cleanwriten'), cleanword = /** @type {HTMLInputElement} */ ($('#cleanword'));
const cleanok = /** @type {HTMLButtonElement} */ ($('#cleanok')), cleanerr = $('#cleanerr'), cleanfinal = $('#cleanfinal');
const cleancancel = $('#cleancancel');
const CLEAN_READ_S = 10, CLEAN_WRITE_S = 60, CLEAN_WORD = 'BORRAR-TODO';
let cleanTimer = null;

function cleanCloseModal() {
  if (cleanTimer) clearInterval(cleanTimer);
  cleanTimer = null;
  cleanModal.hidden = true;
  cleanread.hidden = false;
  cleanwrite.hidden = true;
  cleanfinal.hidden = true;
  cleanfinal.textContent = '';
  cleanword.value = '';
  cleanword.disabled = true;
  cleanok.disabled = true;
  cleanerr.textContent = '';
  cleanbtn.disabled = false;
}

function cleanStartRead() {
  let left = CLEAN_READ_S;
  const tick = () => {
    left -= 1;
    if (left <= 0) {
      clearInterval(cleanTimer);
      cleanTimer = null;
      cleanread.hidden = true;
      cleanwrite.hidden = false;
      cleanword.disabled = false;
      cleanok.disabled = false;
      cleanword.focus();
      cleanStartWrite();
    } else {
      cleanreadn.textContent = left;
    }
  };
  cleanreadn.textContent = CLEAN_READ_S;
  cleanTimer = setInterval(tick, 1000);
}

function cleanStartWrite() {
  let left = CLEAN_WRITE_S;
  const tick = () => {
    left -= 1;
    if (left <= 0) {
      cleanCloseModal();
      cleanmsg.className = '';
      cleanmsg.textContent = '⏰ Timer de escritura agotado — el reset limpio fue cancelado, no se borró nada.';
    } else {
      cleanwriten.textContent = left;
    }
  };
  cleanwriten.textContent = CLEAN_WRITE_S;
  cleanTimer = setInterval(tick, 1000);
}

export function onWhatsAppTabOpen() {
  refreshSession();
  refreshPairingState();
}

export function initWhatsAppTab() {
  $('#qrchoice').addEventListener('click', () => showPairMode('qr'));
  $('#numchoice').addEventListener('click', () => showPairMode('num'));
  $('#backchoice').addEventListener('click', () => {
    pairChoice.hidden = false;
    methodBack.hidden = true;
    pairmodeQr.hidden = true;
    pairmodeNum.hidden = true;
    stopQrTimer();
  });

  genqrbtn.addEventListener('click', () => { refreshQrFromServer(); });

  pairbtn.addEventListener('click', async () => {
    const phone = pairphone.value.trim();
    if (pairingInProgress) return;
    if (!phone) {
      pairmsg2.className = 'err';
      pairmsg2.textContent = '⚠️ Escribe el número con código de país (ej: 56912345678).';
      return;
    }
    pairingInProgress = true;
    pairbtn.disabled = true;
    pairbtn.textContent = '⏳ Solicitando…';
    paircodecard.hidden = true;
    paircode.textContent = '—';
    copycode.textContent = '📋 Copiar código';
    pairmsg2.className = '';
    pairmsg2.textContent = 'Solicitando código de enlace…';
    try {
      const d = await requestPairingCode(phone);
      if (d.success) {
        if (d.code) {
          renderPairingCode(d.code, d.issuedAt, d.expiresAt);
        } else {
          pairmsg2.className = 'ok';
          pairmsg2.textContent = '✅ ' + (d.message || 'Pairing iniciado.');
        }
      } else if (d.needsRestart) {
        pairmsg2.className = 'ok';
        pairmsg2.textContent = '🚀 ' + (d.message || 'Lanzando gateway… el QR aparecerá aquí en unos segundos.');
      } else if (d.method === 'qr') {
        showPairMode('qr', true);
        if (d.expiresAt) {
          qrTimerStartedAt = d.issuedAt || Date.now();
          qrExpiresAt = d.expiresAt;
          startQrTimer();
        }
        pairingInProgress = !!d.busy;
      } else {
        pairmsg2.className = 'err';
        pairmsg2.textContent = '⚠️ ' + (d.message || 'No se pudo iniciar el pairing');
        pairingInProgress = false;
        pairbtn.disabled = false;
        pairbtn.textContent = '📲 Obtener código de 8 caracteres';
      }
    } catch (e) {
      pairmsg2.className = 'err';
      pairmsg2.textContent = '⚠️ Error: ' + e.message;
      pairingInProgress = false;
      pairbtn.disabled = false;
      pairbtn.textContent = '📲 Obtener código de 8 caracteres';
    }
  });

  copycode.addEventListener('click', async () => {
    const value = paircode.textContent.trim();
    if (!value || value === '—') return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        if (!document.execCommand('copy')) throw new Error('portapapeles no disponible');
        area.remove();
      }
      copycode.textContent = '✅ Copiado';
      setTimeout(() => { copycode.textContent = '📋 Copiar código'; }, 1600);
    } catch (e) {
      pairmsg2.className = 'err';
      pairmsg2.textContent = '⚠️ No se pudo copiar automáticamente; selecciona el código manualmente.';
    }
  });

  resetbtn.addEventListener('click', async () => {
    if (!confirm('⚠️ ¿Borrar la sesión guardada y reiniciar el gateway?\n\nSe desvinculará el número actual y habrá que escanear un QR nuevo.')) return;
    resetmsg.className = '';
    resetmsg.textContent = 'Borrando sesión y reiniciando…';
    resetbtn.disabled = true;
    try {
      const d = await resetSession();
      resetmsg.className = d.success ? 'ok' : 'err';
      resetmsg.textContent = (d.success ? '✅ ' : '⚠️ ') + (d.message || '');
    } catch (e) {
      resetmsg.className = 'err';
      resetmsg.textContent = '⚠️ Error: ' + e.message;
    }
  });

  cleanbtn.addEventListener('click', () => {
    if (!confirm('🧨 RESET LIMPIO (FÁBRICA)\n\nSe borrará TODO el estado de runtime y habrá que volver a vincular WhatsApp.\n\n' +
      'Confirmación 1/2. Se abrirá un aviso con timer de lectura (10s) y luego deberás escribir ' + CLEAN_WORD + ' en 60s.')) return;
    cleanbtn.disabled = true;
    cleanModal.hidden = false;
    cleanStartRead();
  });

  cleanok.addEventListener('click', async () => {
    if (cleanword.value.trim().toUpperCase() !== CLEAN_WORD) {
      cleanerr.textContent = '⚠️ Palabra incorrecta. Escribe exactamente ' + CLEAN_WORD + ' (ventana de escritura sigue activa).';
      return;
    }
    cleanword.disabled = true;
    cleanok.disabled = true;
    if (cleanTimer) clearInterval(cleanTimer);
    cleanTimer = null;
    try {
      const d = await resetCleanFactory();
      cleanfinal.hidden = false;
      cleanfinal.className = d.success ? '' : 'err';
      cleanfinal.style.color = d.success ? '#4ade80' : '#f87171';
      cleanfinal.textContent = (d.success ? '✅ ' : '⚠️ ') + (d.message || '');
      if (d.success) {
        cleanread.hidden = true;
        cleanwrite.hidden = true;
        cleanModal.hidden = true;
        resetbtn.disabled = true;
      }
    } catch (e) {
      cleanerr.textContent = '⚠️ Error: ' + e.message;
      cleanword.disabled = false;
      cleanok.disabled = false;
    }
  });

  cleancancel.addEventListener('click', () => {
    cleanCloseModal();
    cleanmsg.className = '';
    cleanmsg.textContent = '✖️ Reset limpio cancelado — no se borró nada.';
  });
}
