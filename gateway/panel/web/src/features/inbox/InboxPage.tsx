import { useParams } from 'react-router-dom';
import { Archive, Bell, CircleHelp, MessageSquareText, Search, UsersRound } from 'lucide-react';
import { BrandLabel } from '../../app/AppShell';

export function InboxPage() {
  const { conversationId } = useParams();

  return (
    <div className="inbox-layout">
      <section className="conversation-column" aria-label="Conversaciones">
        <header className="conversation-header">
          <div className="conversation-title-row">
            <div>
              <BrandLabel />
              <h1>Bandeja</h1>
              <p className="header-subtitle">Tus conversaciones, en un solo lugar.</p>
            </div>
            <button className="icon-button quiet-icon" type="button" aria-label="Ayuda de la bandeja" title="Ayuda">
              <CircleHelp aria-hidden="true" size={19} />
            </button>
          </div>
          <div className="search-placeholder" aria-label="Búsqueda de conversaciones próximamente">
            <Search aria-hidden="true" size={17} />
            <span>Buscar conversaciones</span>
            <span className="search-shortcut" aria-hidden="true">⌘ K</span>
          </div>
          <div className="list-tools" aria-label="Filtros previstos; se habilitarán al conectar el historial" aria-disabled="true">
            <span className="filter-pill is-selected">Todas</span>
            <span className="filter-pill">No leídas</span>
            <span className="filter-pill">Abiertas</span>
          </div>
        </header>

        <div className="conversation-empty" role="status">
          <div className="empty-icon-wrap"><Archive aria-hidden="true" size={20} /></div>
          <h2>El historial aparecerá aquí</h2>
          <p>La próxima entrega conectará esta bandeja con tus conversaciones reales. No mostramos datos de ejemplo.</p>
        </div>
        <footer className="conversation-footer">
          <span>Vista preliminar</span>
          <span className="footer-divider" aria-hidden="true">·</span>
          <span>Datos reales en la siguiente entrega</span>
        </footer>
      </section>

      <section className="thread-column" aria-label="Historial del chat">
        <header className="thread-header">
          <div className="thread-contact">
            <div className="contact-avatar neutral-avatar" aria-hidden="true"><MessageSquareText size={20} /></div>
            <div>
              <h2>{conversationId ? 'Conversación' : 'Selecciona un chat'}</h2>
              <p>{conversationId ? 'El historial se conectará en la siguiente entrega.' : 'Elige una conversación para ver el historial'}</p>
            </div>
          </div>
          <div className="thread-actions">
            <button className="icon-button" type="button" aria-label="Buscar en el chat" disabled><Search aria-hidden="true" size={19} /></button>
            <button className="icon-button" type="button" aria-label="Notificaciones del chat" disabled><Bell aria-hidden="true" size={19} /></button>
          </div>
        </header>
        <div className="thread-empty" role="status">
          <div className="thread-empty-orbit"><MessageSquareText aria-hidden="true" size={29} strokeWidth={1.6} /></div>
          <h2>Un espacio para conversar mejor</h2>
          <p>Aquí tendrás el historial completo y el contexto de cada chat.</p>
          <div className="thread-capabilities" aria-label="Canales compatibles">
            <span><i className="channel-mark whatsapp-mark" aria-hidden="true" /> WhatsApp</span>
            <span><i className="channel-mark telegram-mark" aria-hidden="true" /> Telegram</span>
          </div>
        </div>
        <footer className="composer-preview" aria-label="Compositor disponible en una próxima entrega">
          <span>Responder desde el chat estará disponible al conectar el historial.</span>
          <button className="send-preview" type="button" disabled aria-label="Enviar mensaje próximamente">↗</button>
        </footer>
      </section>

      <aside className="context-column" aria-label="Información del contacto">
        <header className="context-header">
          <div>
            <span className="eyebrow">DETALLES</span>
            <h2>Información</h2>
          </div>
          <button className="icon-button quiet-icon" type="button" aria-label="Ayuda con la ficha" title="Ayuda">
            <CircleHelp aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="context-empty">
          <div className="context-avatar-placeholder" aria-hidden="true"><UsersRound size={22} /></div>
          <h3>Sin chat seleccionado</h3>
          <p>La ficha mostrará los datos disponibles del contacto y la cobertura del historial.</p>
        </div>
        <div className="context-note">
          <span className="note-mark" aria-hidden="true">i</span>
          <p>Los nombres y datos visibles dependerán de la información disponible en cada canal.</p>
        </div>
      </aside>
    </div>
  );
}
