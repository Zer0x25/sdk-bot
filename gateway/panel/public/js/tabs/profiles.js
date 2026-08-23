// @ts-check
/**
 * 🧠 Pestaña Perfiles: Editor de perfiles SOUL, importación/exportación de Markdown y prompt compilado
 */

import { $, esc } from '../utils.js';
import { getProfiles, getProfileFile, getProfileDetail, reloadProfiles, saveProfile, deleteProfile } from '../api.js';

const plist = /** @type {HTMLSelectElement} */ ($('#pselect'));
const pkey = /** @type {HTMLInputElement} */ ($('#pkey'));
const pcontent = /** @type {HTMLTextAreaElement} */ ($('#pcontent'));
const pstate = $('#pstate');
const pmsg = $('#pmsg');
const pfile = /** @type {HTMLInputElement} */ ($('#pfile'));
const ppromptview = $('#ppromptview');
const pdel = /** @type {HTMLButtonElement} */ ($('#pdel'));

let currentProfile = null;

function setProfileMsg(text, cls) {
  pmsg.className = cls || '';
  pmsg.textContent = text;
}

export function loadProfiles(selected) {
  getProfiles()
    .then(d => {
      const list = d.profiles || [];
      const opts = list.map(p => {
        const key = typeof p === 'string' ? p : (p && p.key);
        const nombre = (typeof p === 'object' && p && p.nombre) ? p.nombre : key;
        return '<option value="' + esc(key) + '"' + (key === (selected || currentProfile) ? ' selected' : '') + '>' + esc(nombre + ' (' + key + ')') + '</option>';
      }).join('');
      plist.innerHTML = '<option value="">' + (list.length ? '— Seleccionar perfil —' : 'Sin perfiles (brain apagado o carpeta vacía)') + '</option>' + opts;
    })
    .catch(e => {
      plist.innerHTML = '<option value="">Error: ' + esc(e.message) + '</option>';
    });
}

function openProfileEditor(key, content, editableKey) {
  currentProfile = key;
  pkey.value = key || '';
  pkey.disabled = !editableKey;
  pcontent.value = content || '';
  pstate.textContent = key === 'default' ? 'perfil protegido (no se puede eliminar)' : '';
  pdel.disabled = !key || key === 'default';
  ppromptview.hidden = true;
  setProfileMsg('', '');
}

async function openProfile(key) {
  try {
    const d = await getProfileFile(key);
    openProfileEditor(key, d.content, false);
  } catch (e) {
    setProfileMsg('⚠️ ' + e.message, 'err');
  }
}

export function initProfilesTab() {
  plist.addEventListener('change', () => {
    const key = plist.value;
    if (key) openProfile(key);
  });

  $('#pnew').addEventListener('click', () => {
    openProfileEditor('', '', true);
    pkey.focus();
  });

  $('#preload').addEventListener('click', async () => {
    await reloadProfiles().catch(() => {});
    loadProfiles(currentProfile);
    setProfileMsg('🔄 Perfiles recargados del brain.', 'ok');
  });

  $('#pimport').addEventListener('click', () => pfile.click());

  pfile.addEventListener('change', async () => {
    const f = pfile.files && pfile.files[0];
    pfile.value = '';
    if (!f) return;
    try {
      const key = f.name.replace(/\.(md|txt)$/i, '');
      openProfileEditor(key, await f.text(), true);
      setProfileMsg('📥 Archivo cargado. Revisa y guarda.', 'ok');
    } catch (e) {
      setProfileMsg('⚠️ No se pudo leer el archivo: ' + e.message, 'err');
    }
  });

  $('#psave').addEventListener('click', async () => {
    const key = pkey.value.trim();
    const content = pcontent.value;
    if (!/^[a-z0-9_-]{1,32}$/i.test(key)) {
      setProfileMsg('⚠️ Clave inválida: solo letras, números, _ y - (hasta 32 caracteres).', 'err');
      return;
    }
    if (!content.trim()) {
      setProfileMsg('⚠️ El contenido no puede estar vacío.', 'err');
      return;
    }
    try {
      const d = await saveProfile(key, content);
      if (!d.success) throw new Error(d.message || 'el brain rechazó el perfil');
      openProfileEditor(key, content, false);
      setProfileMsg('✅ Perfil "' + d.nombre + '" guardado (' + d.reglas + ' reglas, ' + d.ejemplos + ' ejemplos).', 'ok');
      loadProfiles(key);
    } catch (e) {
      setProfileMsg('⚠️ ' + e.message, 'err');
    }
  });

  $('#pexport').addEventListener('click', async () => {
    const key = currentProfile || pkey.value.trim();
    if (!key) return setProfileMsg('⚠️ No hay perfil para exportar.', 'err');
    try {
      const d = await getProfileFile(key);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([d.content], { type: 'text/markdown' }));
      a.download = key + '.md';
      a.click();
      setProfileMsg('⬇️ Exportado: ' + key + '.md', 'ok');
    } catch (e) {
      setProfileMsg('⚠️ ' + e.message, 'err');
    }
  });

  $('#pprompt').addEventListener('click', async () => {
    const key = currentProfile || pkey.value.trim();
    if (!key) return setProfileMsg('⚠️ No hay perfil seleccionado.', 'err');
    try {
      const d = await getProfileDetail(key);
      ppromptview.hidden = !ppromptview.hidden;
      if (!ppromptview.hidden) {
        ppromptview.textContent = '# ' + d.nombre + '\n' + (d.descripcion || '') + '\n\n--- PROMPT COMPILADO ---\n\n' + (d.prompt || '(vacío)');
      }
    } catch (e) {
      setProfileMsg('⚠️ ' + e.message, 'err');
    }
  });

  pdel.addEventListener('click', async () => {
    const key = currentProfile;
    if (!key || key === 'default') return;
    if (!confirm('⚠️ ¿Eliminar el perfil "' + key + '" del brain?\n\nLos contactos asignados a él pasarán al perfil default.')) return;
    try {
      const d = await deleteProfile(key);
      if (!d.success) throw new Error(d.message || 'no se pudo eliminar');
      setProfileMsg('🗑️ Perfil "' + key + '" eliminado.', 'ok');
      openProfileEditor('', '', true);
      loadProfiles();
    } catch (e) {
      setProfileMsg('⚠️ ' + e.message, 'err');
    }
  });
}
