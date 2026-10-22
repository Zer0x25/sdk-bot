import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type MouseEvent,
  type ReactNode,
  type SetStateAction
} from 'react';
import { NavLink } from 'react-router-dom';
import {
  Bot,
  ChartNoAxesColumnIncreasing,
  Inbox,
  MessageCircleMore,
  RadioTower,
  Settings2,
  UsersRound
} from 'lucide-react';

const AssistantDraftGuardContext = createContext<Dispatch<SetStateAction<boolean>>>(() => {});

export function useAssistantDraftGuard() {
  return useContext(AssistantDraftGuardContext);
}

const navigation = [
  { to: '/', label: 'Bandeja', icon: Inbox, end: true },
  { to: '/summary', label: 'Resumen', icon: ChartNoAxesColumnIncreasing },
  { to: '/contacts', label: 'Contactos', icon: UsersRound },
  { to: '/channels', label: 'Canales', icon: RadioTower },
  { to: '/assistant', label: 'Asistente', icon: Bot }
];

export function AppShell({ children }: { children: ReactNode }) {
  const [assistantDraftDirty, setAssistantDraftDirty] = useState(false);
  function guardNavigation(event: MouseEvent<HTMLAnchorElement>) {
    if (!assistantDraftDirty || new URL(event.currentTarget.href).pathname === window.location.pathname) return;
    if (!window.confirm('Hay cambios sin guardar en Asistente. ¿Descartar el borrador y salir?')) {
      event.preventDefault();
      return;
    }
    setAssistantDraftDirty(false);
  }

  return (
    <AssistantDraftGuardContext.Provider value={setAssistantDraftDirty}>
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Saltar al contenido</a>
      <aside className="workspace-rail" aria-label="SDK-Bot">
        <NavLink className="brand-mark" to="/" aria-label="SDK-Bot, ir a la bandeja" end onClick={guardNavigation}>
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
              onClick={guardNavigation}
            >
              <Icon aria-hidden="true" size={21} strokeWidth={1.9} />
              <span className="rail-link-label">{label}</span>
            </NavLink>
          ))}
          <NavLink
            className={({ isActive }) => `rail-link mobile-system-link${isActive ? ' is-active' : ''}`}
            to="/system"
            aria-label="Sistema"
            title="Sistema"
            onClick={guardNavigation}
          >
            <Settings2 aria-hidden="true" size={21} strokeWidth={1.9} />
            <span className="rail-link-label">Sistema</span>
          </NavLink>
        </nav>
        <div className="rail-footer">
          <NavLink
            className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
            to="/system"
            aria-label="Sistema"
            title="Sistema"
            onClick={guardNavigation}
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
    </AssistantDraftGuardContext.Provider>
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
