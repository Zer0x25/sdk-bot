// @ts-check
/**
 * ✈️ Pestaña Telegram: Configuración de Bot Token y Chat ID, prueba y desconexión
 */

import { $, maskToken } from '../utils.js';
import { getTelegramSettings, testTelegramToken, saveTelegramSettings, getStatus } from '../api.js';

const tgToken = /** @type {HTMLInputElement} */ ($('#tgToken'));
const tgChatId = /** @type {HTMLInputElement} */ ($('#tgChatId'));
const tgMsg = $('#tgMsg');
const tgStatus = $('#tgStatus');
const tgTestBtn = /** @type {HTMLButtonElement} */ ($('#tgTestBtn'));
const tgSaveBtn = /** @type {HTMLButtonElement} */ ($('#tgSaveBtn'));
const tgResetBtn = /** @type {HTMLButtonElement} */ ($('#tgResetBtn'));

let rawTgToken = '';
const pendingTelegramTests = new Map();
const TELEGRAM_TEST_PENDING_PREFIX = 'sdkbot_telegram_test_uncertain:';

function telegramTestPendingKey(chatId) {
  return TELEGRAM_TEST_PENDING_PREFIX + (chatId ? `chat:${chatId}` : 'discover');
}

function readPendingTelegramTest(chatId) {
  const keys = [telegramTestPendingKey(chatId), telegramTestPendingKey('')];
  try {
    for (const key of keys) {
      const stored = globalThis.localStorage?.getItem(key) || pendingTelegramTests.get(key);
      if (stored) return stored;
    }
    return '';
  } catch {
    return keys.map(key => pendingTelegramTests.get(key)).find(Boolean) || '';
  }
}

function writePendingTelegramTest(chatId, idempotencyKey) {
  const key = telegramTestPendingKey(chatId);
  pendingTelegramTests.set(key, idempotencyKey);
  try { globalThis.localStorage?.setItem(key, idempotencyKey); } catch { /* Keep the in-page confirmation gate. */ }
}

function clearPendingTelegramTest(chatId, expectedIdempotencyKey = '', relatedChatId = '') {
  const keys = new Set([telegramTestPendingKey(chatId), telegramTestPendingKey('')]);
  if (relatedChatId) keys.add(telegramTestPendingKey(relatedChatId));
  for (const key of keys) {
    let current = pendingTelegramTests.get(key) || '';
    try { current = globalThis.localStorage?.getItem(key) || current; } catch { /* Fall back to the in-page value. */ }
    if (expectedIdempotencyKey && current !== expectedIdempotencyKey) continue;
    pendingTelegramTests.delete(key);
    try { globalThis.localStorage?.removeItem(key); } catch { /* Keep setup usable if storage is unavailable. */ }
  }
}

function newTelegramTestKey() {
  return globalThis.crypto?.randomUUID?.()
    || `tg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setTgStatus(text, cls) {
  if (!tgStatus) return;
  tgStatus.className = cls || 'hint';
  tgStatus.textContent = text;
}

/** Badge de estado del canal según /status del gateway */
export async function refreshTgStatus() {
  try {
    const d = await getStatus();
    const tg = (d.channels && d.channels.telegram) || {};
    const conn = tg.connection || 'starting';
    const reason = tg.lastDisconnectReason;
    if (conn === 'open') {
      setTgStatus('● Telegram conectado y escuchando comandos.', 'ok');
    } else if (reason === 'token_invalido') {
      setTgStatus('● Token inválido o revocado: genera uno nuevo con @BotFather y guárdalo aquí.', 'bad');
    } else if (reason === 'error_polling') {
      setTgStatus('● Telegram rechazó la conexión. Revisa la configuración y vuelve a guardar.', 'bad');
    } else if (reason === 'identidad_no_verificada') {
      setTgStatus('● Telegram no confirmó que el token pertenezca a un bot. Revisa el token.', 'bad');
    } else if (['error_archivo', 'error_captura', 'archivo_no_disponible', 'respuesta_invalida'].includes(reason)) {
      setTgStatus('● La captura se detuvo sin confirmar más mensajes. Revisa el archivo y reinicia el gateway.', 'bad');
    } else if (reason === 'sin_token') {
      setTgStatus('● Sin token configurado: sigue los pasos de abajo para vincular tu bot.', 'warn');
    } else {
      setTgStatus('● Telegram desconectado o iniciando…', 'warn');
    }
  } catch (e) {
    setTgStatus('Estado no disponible (gateway sin responder).', 'warn');
  }
}

function setTgUIState(connected, configured = connected) {
  if (connected) {
    tgToken.readOnly = true;
    tgChatId.readOnly = true;
    tgToken.style.opacity = '0.5';
    tgChatId.style.opacity = '0.5';
    tgTestBtn.style.display = 'none';
    tgSaveBtn.style.display = 'none';
    tgResetBtn.style.display = 'block';
  } else {
    tgToken.readOnly = false;
    tgChatId.readOnly = false;
    tgToken.style.opacity = '1';
    tgChatId.style.opacity = '1';
    tgTestBtn.style.display = 'block';
    tgSaveBtn.style.display = 'block';
    tgResetBtn.style.display = configured ? 'block' : 'none';
  }
}

export async function loadTgSettings() {
  refreshTgStatus();
  try {
    const d = await getTelegramSettings();
    rawTgToken = d.token || '';
    const complete = !!(d.token && d.chatId);
    setTgUIState(complete, !!d.token);
    tgToken.value = complete ? maskToken(d.token) : rawTgToken;
    tgChatId.value = d.chatId || '';
    tgMsg.style.color = complete ? '#4ade80' : '#aab3c5';
    tgMsg.textContent = complete
      ? '✅ Bot configurado. Desconecta para cambiar el token o el Chat ID.'
      : d.token ? 'Token guardado. Envía /start al bot, pulsa Probar y guarda el Chat ID obtenido.' : '';
  } catch (e) {
    console.error('Error cargando la configuración de Telegram.');
  }
}

export function initTelegramTab() {
  tgToken.addEventListener('focus', () => {
    if (!tgToken.readOnly && rawTgToken) {
      tgToken.value = rawTgToken;
    }
  });

  tgToken.addEventListener('input', e => {
    const target = /** @type {HTMLInputElement} */ (e.target);
    rawTgToken = target.value;
  });

  tgTestBtn.addEventListener('click', async () => {
    const token = rawTgToken.trim() || tgToken.value.trim();
    if (!token) {
      tgMsg.style.color = '#f87171';
      tgMsg.textContent = '⚠️ Ingresa el Token primero.';
      return;
    }
    const requestedChatId = tgChatId.value.trim();
    const previousKey = readPendingTelegramTest(requestedChatId);
    if (previousKey && !confirm('La prueba anterior pudo haberse enviado. Revisa el chat. ¿Confirmas enviar otra prueba?')) {
      tgMsg.style.color = '#fbbf24';
      tgMsg.textContent = '⚠️ No se envió otra prueba. Revisa el chat antes de reintentar.';
      return;
    }
    if (previousKey) clearPendingTelegramTest(requestedChatId, previousKey);
    const idempotencyKey = newTelegramTestKey();
    writePendingTelegramTest(requestedChatId, idempotencyKey);
    tgTestBtn.disabled = true;
    tgMsg.style.color = '#aab3c5';
    tgMsg.textContent = '⏳ Probando conexión...';
    try {
      const d = await testTelegramToken(token, requestedChatId, idempotencyKey);
      const resolvedChatId = d.chatId ? String(d.chatId) : requestedChatId;
      if (d.success) {
        clearPendingTelegramTest(requestedChatId, idempotencyKey, resolvedChatId);
        tgMsg.style.color = '#4ade80';
        tgMsg.textContent = '✅ Mensaje de prueba enviado. Guarda para aplicar el Chat ID.';
        if (d.chatId) tgChatId.value = d.chatId;
      } else if (d.delivery === 'unknown') {
        tgMsg.style.color = '#fbbf24';
        tgMsg.textContent = '⚠️ Telegram pudo haber recibido la prueba. Revisa el chat; para enviar otra, el panel te pedirá confirmación.';
        if (d.chatId) tgChatId.value = d.chatId;
      } else {
        clearPendingTelegramTest(requestedChatId, idempotencyKey, resolvedChatId);
        tgMsg.style.color = '#f87171';
        tgMsg.textContent = '⚠️ Error: ' + (d.message || 'No se pudo verificar');
      }
    } catch {
      tgMsg.style.color = '#fbbf24';
      tgMsg.textContent = '⚠️ No se confirmó el resultado. Revisa el chat antes de volver a probar; el panel pedirá confirmación.';
    }
    tgTestBtn.disabled = false;
  });

  tgSaveBtn.addEventListener('click', async () => {
    const token = rawTgToken.trim() || tgToken.value.trim();
    const chatId = tgChatId.value.trim();
    tgSaveBtn.disabled = true;
    tgMsg.style.color = '#aab3c5';
    tgMsg.textContent = '⏳ Guardando...';
    try {
      const d = await saveTelegramSettings(token, chatId);
      if (d.success) {
        rawTgToken = token;
        tgToken.value = chatId ? maskToken(token) : token;
        setTgUIState(!!chatId, !!token);
        tgMsg.style.color = '#4ade80';
        tgMsg.textContent = chatId ? '✅ ' + (d.message || 'Configuración guardada correctamente.')
          : 'Token guardado. Envía /start al bot, pulsa Probar y vuelve a guardar el Chat ID.';
        // El adaptador se reconecta en caliente; refrescar el badge enseguida
        setTimeout(refreshTgStatus, 2500);
      } else {
        tgMsg.style.color = '#f87171';
        tgMsg.textContent = '⚠️ Error al guardar: ' + (d.message || '');
      }
    } catch (e) {
      tgMsg.style.color = '#f87171';
      tgMsg.textContent = '⚠️ Error: ' + e.message;
    }
    tgSaveBtn.disabled = false;
  });

  tgResetBtn.addEventListener('click', async () => {
    if (!confirm('¿Estás seguro de desconectar Telegram? Dejarás de recibir notificaciones push.')) return;
    tgResetBtn.disabled = true;
    try {
      await saveTelegramSettings('', '');
      rawTgToken = '';
      tgToken.value = '';
      tgChatId.value = '';
      setTgUIState(false);
      setTgStatus('● Sin token configurado: sigue los pasos de abajo para vincular tu bot.', 'warn');
      tgMsg.style.color = '#aab3c5';
      tgMsg.textContent = 'Telegram desconectado. Puedes volver a vincularlo cuando quieras.';
    } catch (e) {
      console.error('Error al desconectar Telegram.');
    }
    tgResetBtn.disabled = false;
  });
}
