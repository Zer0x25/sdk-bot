import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, Database, Download, HardDrive, Pause, Play, Power, RefreshCw,
  RotateCcw, ScrollText, Server, ShieldAlert, Terminal, Trash2, X
} from 'lucide-react';
import { getSession } from '../inbox/api';
import {
  clearSystemLogs,
  getSystemStatus,
  resetFactory,
  resetWhatsAppSession,
  restartGateway,
  sendAdminCommand,
  startBrain,
  type AdminCommandReply,
  type SystemComponent,
  SystemApiError
} from './api';

type RecordValue = Record<string, unknown>;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface SystemLogLine {
  id: number;
  level: LogLevel;
  time: string;
  category: string;
  message: string;
}

interface TerminalEntry {
  id: number;
  command: string;
  replies: AdminCommandReply[];
  failed: boolean;
}

type FactoryStep = 'closed' | 'reading' | 'writing' | 'submitting' | 'uncertain';

const MAX_COMMAND_LENGTH = 4000;
const MAX_LOG_LINES = 800;
const MAX_DOCUMENT_BASE64_LENGTH = 8_000_000;

function asRecord(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}

function textValue(value: unknown, fallback = '—') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formatBytes(value: unknown) {
  const bytes = numberValue(value);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUptime(value: unknown) {
  const total = Math.max(0, Math.floor(numberValue(value)));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return days ? `${days} d ${hours} h` : hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function formatLog(value: unknown, component: SystemComponent, id: number): SystemLogLine | null {
  if (typeof value !== 'string') return null;
  let message = value.trimEnd();
  let time = '';
  let category = '';
  let level: LogLevel = 'info';

  if (component === 'gateway' && message.startsWith('{')) {
    try {
      const parsed = asRecord(JSON.parse(message));
      const numericLevel = numberValue(parsed.level);
      level = numericLevel >= 50 ? 'error' : numericLevel >= 40 ? 'warn' : numericLevel >= 30 ? 'info' : 'debug';
      const timestamp = numberValue(parsed.time, Date.now());
      time = new Date(timestamp).toLocaleTimeString('es-CL', { hour12: false });
      category = typeof parsed.cat === 'string' ? parsed.cat : '';
      message = typeof parsed.msg === 'string' ? parsed.msg : message;
    } catch {
      // Unstructured lines stay visible as plain text.
    }
  } else {
    const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d+)?)\s+(\w+)\s+(?:\[([^\]]+)\]\s+)?(.*)$/.exec(message);
    if (match) {
      time = match[1].slice(11);
      const rawLevel = match[2].toLowerCase();
      level = rawLevel === 'critical' || rawLevel === 'error' ? 'error'
        : rawLevel === 'warn' || rawLevel === 'warning' ? 'warn'
          : rawLevel === 'debug' ? 'debug' : 'info';
      category = match[3] || '';
      message = match[4];
    }
  }

  if (!time) time = new Date().toLocaleTimeString('es-CL', { hour12: false });
  return { id, level, time, category, message };
}

function levelAccepted(level: LogLevel, filter: string) {
  if (filter === 'all') return true;
  if (filter === 'error') return level === 'error';
  const rank = { debug: 0, info: 1, warn: 2, error: 3 };
  return rank[level] >= rank[filter as keyof typeof rank];
}

function SystemMetricCard({ title, rows, children }: {
  title: string;
  rows: Array<[string, string]>;
  children?: ReactNode;
}) {
  return (
    <article className="system-card">
      <h2>{title}</h2>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {children && <div className="system-card-actions">{children}</div>}
    </article>
  );
}

export function SystemPage() {
  const queryClient = useQueryClient();
  const [logComponent, setLogComponent] = useState<SystemComponent>('gateway');
  const [logLevel, setLogLevel] = useState('all');
  const [logsPaused, setLogsPaused] = useState(false);
  const [logGeneration, setLogGeneration] = useState(0);
  const [logStatus, setLogStatus] = useState('');
  const [logNotice, setLogNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<SystemLogLine[]>([]);
  const logSequence = useRef(0);
  const logBox = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [commandText, setCommandText] = useState('');
  const [commandError, setCommandError] = useState<string | null>(null);
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const terminalSequence = useRef(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);
  const [factoryStep, setFactoryStep] = useState<FactoryStep>('closed');
  const [factorySeconds, setFactorySeconds] = useState(0);
  const [factoryWord, setFactoryWord] = useState('');
  const factoryWordInput = useRef<HTMLInputElement>(null);

  const sessionQuery = useQuery({
    queryKey: ['system', 'session'],
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000
  });
  const canManage = sessionQuery.data?.actor.capabilities.includes('admin:write') === true;
  const statusQuery = useQuery({
    queryKey: ['system', 'status'],
    queryFn: ({ signal }) => getSystemStatus(signal),
    enabled: canManage,
    refetchInterval: 10_000,
    staleTime: 5_000
  });

  const commandMutation = useMutation({
    mutationFn: sendAdminCommand,
    onSuccess: async (result, command) => {
      setTerminalEntries(current => [{ id: ++terminalSequence.current, command, replies: result.replies, failed: !result.ok }, ...current].slice(0, 30));
      setCommandText('');
      setCommandError(null);
      await queryClient.invalidateQueries({ queryKey: ['system', 'status'] });
    },
    onError: value => {
      const message = value instanceof Error ? value.message : 'No se pudo enviar el comando.';
      setCommandError(value instanceof SystemApiError && (value.status === 0 || value.status >= 500)
        ? `${message} El comando pudo haberse ejecutado; verifica el estado antes de repetirlo.`
        : message);
    }
  });

  const brainMutation = useMutation({
    mutationFn: startBrain,
    onSuccess: async result => {
      setFeedback(result.message || (result.success ? 'El brain está iniciando.' : 'No se pudo iniciar el brain.'));
      setFeedbackError(!result.success);
      await queryClient.invalidateQueries({ queryKey: ['system', 'status'] });
    },
    onError: value => { setFeedback(value instanceof Error ? value.message : 'No se pudo iniciar el brain.'); setFeedbackError(true); }
  });

  const botToggleMutation = useMutation({
    mutationFn: sendAdminCommand,
    onSuccess: async result => {
      setFeedback(result.replies.find(reply => typeof reply.text === 'string')?.text || (result.ok ? 'Se actualizó el estado del bot.' : 'El comando no pudo cambiar el estado del bot.'));
      setFeedbackError(!result.ok);
      await queryClient.invalidateQueries({ queryKey: ['system', 'status'] });
    },
    onError: value => { setFeedback(value instanceof Error ? value.message : 'No se pudo cambiar el estado del bot.'); setFeedbackError(true); }
  });

  const logClearMutation = useMutation({
    mutationFn: clearSystemLogs,
    onSuccess: result => {
      if (result.success) {
        setLogs([]);
        setLogNotice('Archivo activo limpiado; los logs rotados se conservan.');
        setLogGeneration(value => value + 1);
      } else setLogNotice(result.message || 'No se pudieron limpiar los logs.');
    },
    onError: value => setLogNotice(value instanceof Error ? value.message : 'No se pudieron limpiar los logs.')
  });

  const sessionResetMutation = useMutation({
    mutationFn: resetWhatsAppSession,
    onSuccess: result => {
      setFeedback(result.message || (result.success ? 'Se solicitó el reinicio y el borrado de la sesión.' : 'No se pudo resetear la sesión.'));
      setFeedbackError(!result.success);
    },
    onError: value => { setFeedback(value instanceof Error ? value.message : 'No se pudo resetear la sesión.'); setFeedbackError(true); }
  });

  const restartMutation = useMutation({
    mutationFn: restartGateway,
    onSuccess: result => {
      setFeedback(result.message || (result.success ? 'Se solicitó el reinicio del gateway.' : 'No se pudo reiniciar el gateway.'));
      setFeedbackError(!result.success);
    },
    onError: value => { setFeedback(value instanceof Error ? value.message : 'No se pudo reiniciar el gateway.'); setFeedbackError(true); }
  });

  const factoryMutation = useMutation({
    mutationFn: resetFactory,
    onSuccess: result => {
      setFactoryWord('');
      if (result.success) {
        setFactoryStep('closed');
        setFeedback(result.message || 'Reset limpio completado. El gateway se está reiniciando.');
        setFeedbackError(false);
      } else {
        setFactoryStep('uncertain');
        setFeedback(result.message || 'El reset informó un error. Verifica el estado antes de volver a intentarlo.');
        setFeedbackError(true);
      }
    },
    onError: value => {
      setFactoryStep('uncertain');
      setFactoryWord('');
      setFeedback(value instanceof Error
        ? `No se confirmó el resultado del reset: ${value.message} Verifica el sistema antes de repetir la operación.`
        : 'No se confirmó el resultado del reset. Verifica el sistema antes de repetir la operación.');
      setFeedbackError(true);
    }
  });

  useEffect(() => {
    if (!canManage) return;
    if (logsPaused) {
      setLogStatus('Pausado');
      return;
    }
    if (typeof EventSource === 'undefined') {
      setLogStatus('Este navegador no admite el stream de logs.');
      return;
    }
    setLogStatus('Conectando…');
    const source = new EventSource(`/api/logs?component=${logComponent}&history=100`);
    source.onopen = () => setLogStatus('En vivo');
    source.onmessage = event => {
      try {
        const payload = asRecord(JSON.parse(event.data));
        const parsed = formatLog(payload.line, logComponent, ++logSequence.current);
        if (!parsed) return;
        setLogStatus('En vivo');
        const viewport = logBox.current;
        stickToBottom.current = !viewport || viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 40;
        setLogs(current => [...current, parsed].slice(-MAX_LOG_LINES));
      } catch {
        // Ignore malformed SSE events; the stream remains open for the next line.
      }
    };
    source.onerror = () => setLogStatus('Conexión perdida; el navegador reintentará.');
    return () => source.close();
  }, [canManage, logComponent, logsPaused, logGeneration]);

  useEffect(() => {
    if (!stickToBottom.current || !logBox.current) return;
    logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (factoryStep === 'reading' && factorySeconds === 0) {
      setFactoryStep('writing');
      setFactorySeconds(60);
      return;
    }
    if (factoryStep === 'writing' && factorySeconds === 0) {
      setFactoryStep('closed');
      setFactoryWord('');
      setFeedback('El tiempo para escribir venció. El reset limpio se canceló y no se borró nada.');
      setFeedbackError(false);
      return;
    }
    if (factoryStep !== 'reading' && factoryStep !== 'writing') return;
    const timer = window.setTimeout(() => setFactorySeconds(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [factorySeconds, factoryStep]);

  useEffect(() => {
    if (factoryStep === 'writing') factoryWordInput.current?.focus();
  }, [factoryStep]);

  const status = statusQuery.data;
  const bot = asRecord(status?.bot);
  const brain = asRecord(status?.brain);
  const brainHealth = asRecord(brain.health);
  const healthDetails = asRecord(brainHealth.health);
  const providers = asRecord(healthDetails.providers);
  const primaryProviderName = typeof providers.primary === 'string'
    ? providers.primary.replace(/\s*\([^)]*\)$/, '').trim()
    : textValue(asRecord(providers.primary).provider || asRecord(providers.primary).name, '—');
  const primaryModel = typeof providers.primary === 'string'
    ? /\(([^)]*)\)$/.exec(providers.primary)?.[1]?.trim() || '—'
    : textValue(asRecord(providers.primary).model);
  const memory = asRecord(status?.memory);
  const channelStates = asRecord(status?.channels);
  const whatsapp = asRecord(channelStates.whatsapp);
  const telegram = asRecord(channelStates.telegram);
  const database = asRecord(status?.database);
  const queue = asRecord(status?.queue);
  const broadcast = asRecord(status?.broadcast);
  const runtimeStats = asRecord(status?.runtimeStats);
  const counters = asRecord(status?.counters);
  const botPaused = bot.paused === true;
  const cleanConfirmationMatches = factoryWord.trim().toUpperCase() === 'BORRAR-TODO';
  const visibleLogs = logs.filter(line => levelAccepted(line.level, logLevel));

  function runCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = commandText.trim();
    if (!command) return;
    if (command.length > MAX_COMMAND_LENGTH) {
      setCommandError(`El comando supera el límite de ${MAX_COMMAND_LENGTH} caracteres.`);
      return;
    }
    setCommandError(null);
    commandMutation.mutate(command);
  }

  function toggleBot() {
    const command = botPaused ? '/reanudar' : '/pausar';
    botToggleMutation.mutate(command);
  }

  function downloadReply(reply: AdminCommandReply) {
    const base64 = reply.base64 ?? '';
    if (!base64 || base64.length > MAX_DOCUMENT_BASE64_LENGTH
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      setCommandError('El archivo del comando está vacío o supera el límite de descarga del panel.');
      return;
    }
    try {
      const binary = window.atob(base64);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = (reply.fileName || 'archivo').split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) || 'archivo.bin';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setCommandError('El panel no pudo preparar la descarga del archivo.');
    }
  }

  function requestSessionReset() {
    if (!window.confirm('¿Borrar la sesión guardada de WhatsApp y reiniciar el gateway? Tendrás que volver a vincular el dispositivo.')) return;
    setFeedback(null);
    sessionResetMutation.mutate();
  }

  function requestGatewayRestart() {
    if (!window.confirm('¿Reiniciar el gateway? La sesión de WhatsApp y los demás datos se conservarán.')) return;
    setFeedback(null);
    restartMutation.mutate();
  }

  function openFactoryReset() {
    if (!window.confirm('Reset limpio de fábrica: se borrará todo el estado operativo indicado en el siguiente aviso. Los perfiles Markdown se conservan. ¿Continuar?')) return;
    setFeedback(null);
    setFactoryWord('');
    setFactorySeconds(10);
    setFactoryStep('reading');
  }

  function closeFactoryReset() {
    if (factoryStep === 'submitting' || factoryStep === 'uncertain') return;
    setFactoryStep('closed');
    setFactoryWord('');
    setFeedback('Reset limpio cancelado. No se borró nada.');
    setFeedbackError(false);
  }

  function executeFactoryReset() {
    if (factoryStep !== 'writing' || !cleanConfirmationMatches || factoryMutation.isPending) return;
    setFactoryStep('submitting');
    setFeedback(null);
    factoryMutation.mutate();
  }

  function confirmClearLogs() {
    const name = logComponent === 'brain' ? 'Brain' : 'Gateway';
    if (!window.confirm(`¿Limpiar el archivo activo de logs de ${name}? Los archivos rotados se conservan.`)) return;
    setLogStatus('Limpiando…');
    logClearMutation.mutate(logComponent);
  }

  const sessionUnavailable = !sessionQuery.isPending && sessionQuery.isError;

  return (
    <section className="system-page" aria-labelledby="system-title">
      <header className="system-header">
        <div>
          <p className="eyebrow"><Activity aria-hidden="true" size={14} /> Operación y mantenimiento</p>
          <h1 id="system-title">Sistema</h1>
          <p className="system-subtitle">Diagnóstico, comandos administrativos y mantenimiento protegido.</p>
        </div>
        {sessionQuery.isPending ? <span className="system-permission">Comprobando permisos…</span>
          : sessionQuery.isError ? <span className="system-permission" role="alert">No se pudo comprobar tu sesión.</span>
            : !canManage && <span className="system-permission">Solo administración</span>}
      </header>

      {sessionUnavailable && <div className="system-state system-state-error" role="alert">
        <p>No se pudo comprobar la sesión. Vuelve a intentarlo.</p>
        <button className="system-secondary-button" type="button" onClick={() => void sessionQuery.refetch()}><RefreshCw aria-hidden="true" size={14} /> Reintentar</button>
      </div>}
      {sessionQuery.isSuccess && !canManage && (
        <div className="system-readonly" role="note">
          <ShieldAlert aria-hidden="true" size={22} />
          <div><h2>Se requiere permiso administrativo</h2><p>Estado detallado, logs, comandos y mantenimiento solo están disponibles para una sesión con <code>admin:write</code>.</p></div>
        </div>
      )}

      {sessionQuery.isSuccess && canManage && (
        <>
          {feedback && <p className={`system-feedback${feedbackError ? ' is-error' : ''}`} role={feedbackError ? 'alert' : 'status'}>{feedback}</p>}

          <section className="system-section" aria-labelledby="system-diagnostics-title">
            <div className="system-section-heading">
              <div><p className="eyebrow"><Server aria-hidden="true" size={13} /> Diagnóstico</p><h2 id="system-diagnostics-title">Estado de procesos y canales</h2></div>
              <button className="system-secondary-button" type="button" onClick={() => void statusQuery.refetch()} disabled={statusQuery.isFetching}>
                <RefreshCw aria-hidden="true" size={14} /> {statusQuery.isFetching ? 'Actualizando…' : 'Actualizar'}
              </button>
            </div>

            {statusQuery.isPending && <div className="system-state" role="status">Cargando diagnóstico…</div>}
            {statusQuery.isError && <div className="system-state system-state-error" role="alert">
              <p>{statusQuery.error instanceof Error ? statusQuery.error.message : 'No se pudo cargar el estado del gateway.'}</p>
              <button className="system-secondary-button" type="button" onClick={() => void statusQuery.refetch()}><RefreshCw aria-hidden="true" size={14} /> Reintentar</button>
            </div>}
            {status && <div className="system-status-grid">
              <SystemMetricCard title="Gateway" rows={[
                ['Estado', textValue(status.status)],
                ['Tiempo activo', formatUptime(status.uptime_seconds)],
                ['Node', textValue(status.node)],
                ['Proceso', String(numberValue(status.pid, 0))],
                ['Memoria RSS', formatBytes(memory.rss)],
                ['Heap', `${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}`]
              ]} />
              <SystemMetricCard title="Canales" rows={[
                ['WhatsApp', textValue(whatsapp.connection)],
                ['Reintentos WA', String(numberValue(whatsapp.reconnectAttempt))],
                ['Telegram', textValue(telegram.connection)],
                ['Reintentos TG', String(numberValue(telegram.reconnectAttempt))]
              ]} />
              <SystemMetricCard title="Brain" rows={[
                ['Estado', textValue(brainHealth.state)],
                ['Proveedor principal', primaryProviderName],
                ['Modelo', primaryModel],
                ['Llamadas IA', String(numberValue(brain.aiCalls))],
                ['Último error', textValue(brain.lastErrorMsg || brainHealth.lastError, 'Sin errores reportados').slice(0, 180)]
              ]}>
                {(brainHealth.state === 'Stopped' || brainHealth.reachable === false) && (
                  <button className="system-primary-button" type="button" onClick={() => brainMutation.mutate()} disabled={brainMutation.isPending}>
                    <Power aria-hidden="true" size={14} /> {brainMutation.isPending ? 'Iniciando…' : 'Iniciar brain'}
                  </button>
                )}
              </SystemMetricCard>
              <SystemMetricCard title="Automatización y almacenamiento" rows={[
                ['Bot', botPaused ? 'Pausado' : 'Activo'],
                ['Perfil global', textValue(bot.profile)],
                ['Modo global', textValue(bot.globalMode || database.globalMode)],
                ['Contactos', String(numberValue(database.contacts))],
                ['Cola', `${numberValue(queue.pending)} / ${numberValue(queue.max)}`],
                ['Broadcasts pendientes', String(numberValue(broadcast.pending))],
                ['Mensajes recibidos', String(numberValue(runtimeStats.receivedMessages))],
                ['Mensajes enviados', String(numberValue(counters.sentMessages))]
              ]}>
                <button className="system-secondary-button" type="button" onClick={toggleBot} disabled={botToggleMutation.isPending || commandMutation.isPending}>
                  {botPaused ? <Play aria-hidden="true" size={14} /> : <Pause aria-hidden="true" size={14} />}
                  {botToggleMutation.isPending ? 'Aplicando…' : botPaused ? 'Reanudar bot' : 'Pausar bot'}
                </button>
              </SystemMetricCard>
            </div>}
          </section>

          <section className="system-section" aria-labelledby="system-terminal-title">
            <div className="system-section-heading">
              <div><p className="eyebrow"><Terminal aria-hidden="true" size={13} /> Comandos</p><h2 id="system-terminal-title">Consola administrativa</h2></div>
            </div>
            <p className="system-help">Ejecuta los comandos del chat administrativo mediante el mismo manejador. No es una shell del sistema operativo.</p>
            <form className="system-terminal-form" onSubmit={runCommand}>
              <label className="visually-hidden" htmlFor="system-command-input">Comando administrativo</label>
              <input id="system-command-input" value={commandText} onChange={event => setCommandText(event.currentTarget.value)}
                maxLength={MAX_COMMAND_LENGTH} autoComplete="off" placeholder="Ej.: /estado o /pausar" disabled={commandMutation.isPending || botToggleMutation.isPending} />
              <button className="system-primary-button" type="submit" disabled={commandMutation.isPending || botToggleMutation.isPending || !commandText.trim()}>
                <Terminal aria-hidden="true" size={14} /> {commandMutation.isPending ? 'Ejecutando…' : 'Ejecutar'}
              </button>
            </form>
            <p className="system-character-count">{commandText.length} / {MAX_COMMAND_LENGTH} caracteres</p>
            {commandError && <p className="system-inline-error" role="alert">{commandError}</p>}
            {terminalEntries.length > 0 ? <div className="system-terminal-output" aria-label="Historial de comandos">
              {terminalEntries.map(entry => <article className={`system-terminal-entry${entry.failed ? ' is-error' : ''}`} key={entry.id}>
                <code className="system-terminal-command">$ {entry.command}</code>
                {entry.replies.length === 0 ? <p className="system-terminal-empty">(sin respuesta)</p> : entry.replies.map((reply, index) => (
                  <div className="system-terminal-reply" key={`${entry.id}-${index}`}>
                    {reply.type === 'document' ? <>
                      <button className="system-download-button" type="button" onClick={() => downloadReply(reply)}><Download aria-hidden="true" size={14} /> Descargar {reply.fileName || 'archivo'}</button>
                      {reply.caption && <p>{reply.caption.slice(0, 1000)}</p>}
                    </> : <pre>{(reply.text || JSON.stringify(reply)).slice(0, 20_000)}</pre>}
                  </div>
                ))}
              </article>)}
            </div> : <p className="system-terminal-empty">La salida de la consola se conserva en esta vista mientras permanezca abierta.</p>}
          </section>

          <section className="system-section" aria-labelledby="system-logs-title">
            <div className="system-section-heading">
              <div><p className="eyebrow"><ScrollText aria-hidden="true" size={13} /> Registros</p><h2 id="system-logs-title">Logs en vivo</h2></div>
            </div>
            <div className="system-log-toolbar">
              <label><span>Proceso</span><select value={logComponent} onChange={event => {
                setLogs([]); setLogComponent(event.currentTarget.value as SystemComponent); setLogStatus('Conectando…');
              }}>
                <option value="gateway">Gateway</option><option value="brain">Brain</option>
              </select></label>
              <label><span>Nivel</span><select value={logLevel} onChange={event => setLogLevel(event.currentTarget.value)}>
                <option value="all">Todos</option><option value="info">Info y superiores</option><option value="warn">Warn y superiores</option><option value="error">Solo errores</option>
              </select></label>
              <span className="system-log-status" role="status">{logStatus}</span>
              <div className="system-log-actions">
                <button className="system-secondary-button" type="button" onClick={() => {
                  if (logsPaused) setLogs([]);
                  setLogsPaused(value => !value);
                }}>{logsPaused ? <Play aria-hidden="true" size={14} /> : <Pause aria-hidden="true" size={14} />}{logsPaused ? 'Reanudar' : 'Pausar'}</button>
                <button className="system-secondary-button" type="button" onClick={confirmClearLogs} disabled={logClearMutation.isPending}>
                  <Trash2 aria-hidden="true" size={14} /> {logClearMutation.isPending ? 'Limpiando…' : 'Limpiar archivo activo'}
                </button>
              </div>
            </div>
            {logNotice && <p className="system-feedback" role="status">{logNotice}</p>}
            <div className="system-log-box" role="log" aria-label={`Logs del ${logComponent === 'brain' ? 'Brain' : 'Gateway'}`} aria-live="off" ref={logBox}
              onScroll={event => {
                const element = event.currentTarget;
                stickToBottom.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 40;
              }}>
              {visibleLogs.length ? visibleLogs.map(line => <div className={`system-log-line lv-${line.level}`} key={line.id}>
                <time>{line.time}</time>{line.category && <code>[{line.category}]</code>}<span>{line.message}</span>
              </div>) : <p className="system-log-empty">{logsPaused ? 'Logs en pausa.' : 'Esperando líneas de log…'}</p>}
            </div>
          </section>

          <section className="system-section" aria-labelledby="system-maintenance-title">
            <div className="system-section-heading">
              <div><p className="eyebrow"><HardDrive aria-hidden="true" size={13} /> Mantenimiento</p><h2 id="system-maintenance-title">Acciones de operación</h2></div>
            </div>
            <div className="system-maintenance-grid">
              <article className="system-maintenance-card">
                <h3>Sesión de WhatsApp</h3>
                <p>Borra solo las credenciales de WhatsApp y reinicia el gateway. Después tendrás que vincular el dispositivo de nuevo.</p>
                <button className="system-danger-button" type="button" onClick={requestSessionReset} disabled={sessionResetMutation.isPending}>
                  <RotateCcw aria-hidden="true" size={14} /> {sessionResetMutation.isPending ? 'Solicitando…' : 'Resetear sesión'}
                </button>
              </article>
              <article className="system-maintenance-card">
                <h3>Gateway</h3>
                <p>Reinicia el proceso sin borrar la sesión de WhatsApp ni el archivo operativo.</p>
                <button className="system-secondary-button" type="button" onClick={requestGatewayRestart} disabled={restartMutation.isPending}>
                  <Power aria-hidden="true" size={14} /> {restartMutation.isPending ? 'Solicitando…' : 'Reiniciar gateway'}
                </button>
              </article>
              <article className="system-maintenance-card is-destructive">
                <h3>Reset limpio de fábrica</h3>
                <p>Borra el estado operativo, incluido el historial SQLite, las colas y la memoria. Los perfiles Markdown se conservan.</p>
                <button className="system-danger-button" type="button" onClick={openFactoryReset} disabled={factoryMutation.isPending || factoryStep !== 'closed'}>
                  <Trash2 aria-hidden="true" size={14} /> Abrir doble confirmación
                </button>
              </article>
            </div>
          </section>
        </>
      )}

      {factoryStep !== 'closed' && (
        <div className="system-modal-back">
          <section className="system-factory-modal" role="dialog" aria-modal="true" aria-labelledby="factory-reset-title" aria-describedby="factory-reset-description">
            <div className="system-factory-heading"><div><p className="eyebrow"><Database aria-hidden="true" size={13} /> Acción destructiva</p><h2 id="factory-reset-title">Reset limpio de fábrica</h2></div>
              {factoryStep !== 'submitting' && factoryStep !== 'uncertain' && <button className="system-icon-button" type="button" aria-label="Cancelar reset limpio" onClick={closeFactoryReset}><X aria-hidden="true" size={17} /></button>}
            </div>
            <div id="factory-reset-description">
              <p>Se eliminarán los datos operativos antes de reiniciar:</p>
              <ul>
                <li>Sesión y credenciales vinculadas de WhatsApp.</li>
                <li>Agenda, configuración, broadcasts y cola de mensajes.</li>
                <li>Historial de conversaciones y archivos de SQLite asociados.</li>
                <li>Memoria del brain, logs de Gateway/Brain y locks runtime.</li>
              </ul>
              <p className="system-factory-preserved">Los perfiles Markdown se conservan. El modo global vuelve a <code>ignored_all</code>.</p>
            </div>
            {factoryStep === 'reading' && <p className="system-factory-countdown" role="status">Lee el alcance completo. Podrás escribir la palabra en {factorySeconds} s.</p>}
            {factoryStep === 'writing' && <div className="system-factory-write">
              <label htmlFor="factory-reset-word">Escribe <code>BORRAR-TODO</code> en los próximos {factorySeconds} s</label>
              <input id="factory-reset-word" ref={factoryWordInput} value={factoryWord} onChange={event => setFactoryWord(event.currentTarget.value)} autoComplete="off" />
              <p className="system-help">La confirmación distingue esta operación de un simple reinicio. Si el tiempo vence, no se enviará el reset.</p>
              <button className="system-danger-button" type="button" onClick={executeFactoryReset} disabled={!cleanConfirmationMatches || factoryMutation.isPending}>
                <Trash2 aria-hidden="true" size={14} /> Ejecutar reset limpio
              </button>
            </div>}
            {factoryStep === 'submitting' && <p className="system-factory-countdown" role="status">Enviando una sola solicitud de reset…</p>}
            {factoryStep === 'uncertain' && <div className="system-factory-uncertain" role="alert">
              <p>El resultado no está confirmado. No envíes otra solicitud hasta verificar el estado del sistema.</p>
              <button className="system-secondary-button" type="button" onClick={() => { setFactoryStep('closed'); void statusQuery.refetch(); }}>Cerrar y revisar estado</button>
            </div>}
            {factoryStep !== 'submitting' && factoryStep !== 'uncertain' && <button className="system-secondary-button" type="button" onClick={closeFactoryReset}>Cancelar</button>}
          </section>
        </div>
      )}
    </section>
  );
}
