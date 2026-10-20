import { CircleHelp, UserRound } from 'lucide-react';
import type { Account, Conversation } from './api';

interface Props {
  conversation?: Conversation;
  account?: Account;
  selected?: boolean;
  loading?: boolean;
}

const channelNames = { whatsapp: 'WhatsApp', telegram: 'Telegram' } as const;
const accountStatusNames = {
  connected: 'Conectado',
  disconnected: 'Desconectado',
  connecting: 'Conectando',
  requires_auth: 'Requiere autenticación',
  error: 'Con error'
} as const;

function coverageLabel(conversation: Conversation) {
  const coverage = conversation.historyCoverage;
  if (coverage.kind === 'capturing_since' && coverage.capturingSince) {
    const date = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(new Date(coverage.capturingSince));
    return `Captura observada desde ${date}`;
  }
  if (coverage.kind === 'partial_import') return 'Importación parcial';
  return 'Sin fecha de inicio confirmada';
}

function modeLabel(mode: Conversation['control']['automationMode']) {
  if (mode === 'human') return 'Atención humana';
  if (mode === 'off') return 'Pausada';
  return 'Atención IA';
}

export function ConversationDetails({ conversation, account, selected = false, loading = false }: Props) {
  if (!conversation) {
    return (
      <aside className="context-column" aria-label="Información del contacto">
        <header className="context-header">
          <div><span className="eyebrow">DETALLES</span><h2>Información</h2></div>
          <button className="icon-button quiet-icon" type="button" aria-label="Ayuda con la ficha" title="Ayuda"><CircleHelp aria-hidden="true" size={18} /></button>
        </header>
        <div className="context-empty">
          <div className="context-avatar-placeholder" aria-hidden="true"><UserRound size={22} /></div>
          <h3>{selected ? (loading ? 'Cargando información…' : 'Información no disponible') : 'Sin chat seleccionado'}</h3>
          <p>{selected ? (loading ? 'Estamos consultando el historial y los detalles del contacto.' : 'No se pudieron cargar los detalles de esta conversación.') : 'Selecciona una conversación para ver los datos disponibles y la cobertura de su historial.'}</p>
        </div>
        <div className="context-note"><span className="note-mark" aria-hidden="true">i</span><p>Los nombres y datos visibles dependen de la información compartida por cada canal.</p></div>
      </aside>
    );
  }

  const displayName = conversation.displayName?.trim() || 'Contacto sin nombre';
  return (
    <aside className="context-column" aria-label="Información del contacto">
      <header className="context-header">
        <div><span className="eyebrow">DETALLES</span><h2>Información</h2></div>
        <button className="icon-button quiet-icon" type="button" aria-label="Ayuda con la ficha" title="Ayuda"><CircleHelp aria-hidden="true" size={18} /></button>
      </header>
      <div className="contact-profile">
        <div className="contact-profile-avatar" aria-hidden="true"><UserRound size={24} /></div>
        <h3>{displayName}</h3>
        <p>{account ? channelNames[account.channel] : 'Canal no disponible'}</p>
      </div>
      <dl className="detail-list">
        <div><dt>Canal</dt><dd>{account ? channelNames[account.channel] : 'No disponible'}</dd></div>
        <div><dt>Estado del canal</dt><dd>{account ? accountStatusNames[account.status] : 'No disponible'}</dd></div>
        <div><dt>Atención</dt><dd>{modeLabel(conversation.control.automationMode)}</dd></div>
        <div><dt>Estado</dt><dd>{conversation.control.lifecycle === 'open' ? 'Abierta' : 'Resuelta'}</dd></div>
        <div><dt>Mensajes sin leer</dt><dd>{conversation.unreadCount}</dd></div>
        <div><dt>Cobertura</dt><dd>{coverageLabel(conversation)}</dd></div>
      </dl>
      {conversation.requiresReview && (
        <div className="context-note review-note"><span className="note-mark" aria-hidden="true">!</span><p>Hay una identidad o historial que requiere revisión antes de atender.</p></div>
      )}
      <div className="context-note"><span className="note-mark" aria-hidden="true">i</span><p>La cobertura indica observaciones del archivo, no garantiza que el canal haya entregado todo el historial.</p></div>
    </aside>
  );
}
