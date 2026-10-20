import { NavLink } from 'react-router-dom';
import {
  Bot,
  Inbox,
  MessageCircleMore,
  RadioTower,
  Settings2,
  UsersRound
} from 'lucide-react';
import type { ReactNode } from 'react';

const navigation = [
  { to: '/', label: 'Bandeja', icon: Inbox, end: true },
  { to: '/contacts', label: 'Contactos', icon: UsersRound },
  { to: '/channels', label: 'Canales', icon: RadioTower }
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Saltar al contenido</a>
      <aside className="workspace-rail" aria-label="SDK-Bot">
        <NavLink className="brand-mark" to="/" aria-label="SDK-Bot, ir a la bandeja" end>
          <MessageCircleMore aria-hidden="true" size={23} strokeWidth={2.2} />
        </NavLink>
        <nav className="rail-navigation" aria-label="Navegación principal">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
              to={to}
              end={end}
              aria-label={label}
              title={label}
            >
              <Icon aria-hidden="true" size={21} strokeWidth={1.9} />
              <span className="rail-link-label">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="rail-footer">
          <NavLink
            className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
            to="/system"
            aria-label="Sistema"
            title="Sistema"
          >
            <Settings2 aria-hidden="true" size={21} strokeWidth={1.9} />
            <span className="rail-link-label">Sistema</span>
          </NavLink>
        </div>
      </aside>
      <main id="main-content" className="app-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

export function BrandLabel() {
  return (
    <div className="brand-label">
      <div className="brand-label-icon"><Bot aria-hidden="true" size={17} /></div>
      <span>SDK-Bot</span>
    </div>
  );
}
