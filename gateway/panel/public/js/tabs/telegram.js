// @ts-check
/**
 * ✈️ Pestaña Telegram: Configuración de Bot Token y Chat ID, prueba y desconexión
 */

import { $, maskToken } from '../utils.js';
import { getTelegramSettings, testTelegramToken, saveTelegramSettings } from '../api.js';

const tgToken = /** @type {HTMLInputElement} */ ($('#tgToken'));
const tgChatId = /** @type {HTMLInputElement} */ ($('#tgChatId'));
const tgMsg = $('#tgMsg');
const tgTestBtn = /** @type {HTMLButtonElement} */ ($('#tgTestBtn'));
const tgSaveBtn = /** @type {HTMLButtonElement} */ ($('#tgSaveBtn'));
const tgResetBtn = /** @type {HTMLButtonElement} */ ($('#tgResetBtn'));

let rawTgToken = '';

function setTgUIState(connected) {
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
    tgResetBtn.style.display = 'none';
    tgToken.value = '';
    tgChatId.value = '';
    tgMsg.textContent = '';
  }
}

export async function loadTgSettings() {
  try {
    const d = await getTelegramSettings();
    if (d.token && d.chatId) {
      rawTgToken = d.token;
      tgToken.value = maskToken(d.token);
      tgChatId.value = d.chatId;
      setTgUIState(true);
      tgMsg.style.color = '#4ade80';
      tgMsg.textContent = '✅ Conectado a Telegram.';
    } else {
      setTgUIState(false);
    }
  } catch (e) {
    console.error('Error cargando config telegram', e);
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
    tgTestBtn.disabled = true;
    tgMsg.style.color = '#aab3c5';
    tgMsg.textContent = '⏳ Probando conexión...';
    try {
      const d = await testTelegramToken(token);
      if (d.success) {
        tgMsg.style.color = '#4ade80';
        tgMsg.textContent = '✅ Mensaje de prueba enviado. Chat ID obtenido.';
        if (d.chatId) tgChatId.value = d.chatId;
      } else {
        tgMsg.style.color = '#f87171';
        tgMsg.textContent = '⚠️ Error: ' + (d.message || 'No se pudo verificar');
      }
    } catch (e) {
      tgMsg.style.color = '#f87171';
      tgMsg.textContent = '⚠️ Error: ' + e.message;
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
        tgToken.value = maskToken(token);
        setTgUIState(true);
        tgMsg.style.color = '#4ade80';
        tgMsg.textContent = '✅ Configuración guardada correctamente.';
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
      setTgUIState(false);
    } catch (e) {
      console.error(e);
    }
    tgResetBtn.disabled = false;
  });
}
