import { useQuery } from '@tanstack/react-query';
import { BarChart3, Bot, CalendarDays, MessageSquareText, RefreshCw, UserRound, UsersRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getSummary } from '../inbox/api';

type PeriodDays = 7 | 30;

const utcFormatter = new Intl.DateTimeFormat('es-CL', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  timeZone: 'UTC', hour12: false
});
const countFormatter = new Intl.NumberFormat('es-CL');

function formatUtc(value: string) {
  return `${utcFormatter.format(new Date(value))} UTC`;
}

function channelLabel(channel: 'whatsapp' | 'telegram') {
  return channel === 'whatsapp' ? 'WhatsApp' : 'Telegram';
}

export function SummaryPage() {
  const [periodDays, setPeriodDays] = useState<PeriodDays>(7);
  const period = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - periodDays * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [periodDays]);
  const summary = useQuery({
    queryKey: ['summary', period.from, period.to],
    queryFn: ({ signal }) => getSummary(period, signal),
    staleTime: 30_000
  });

  const data = summary.data;
  return (
    <section className="summary-page" aria-labelledby="summary-title">
      <header className="summary-header">
        <div className="summary-heading-row">
          <div>
            <p className="eyebrow"><BarChart3 aria-hidden="true" size={14} /> Actividad del archivo</p>
            <h1 id="summary-title">Resumen</h1>
            <p className="summary-subtitle">Entradas y respuestas registradas por los canales conectados.</p>
          </div>
          <label className="summary-period-select">
            <span><CalendarDays aria-hidden="true" size={15} /> Periodo</span>
            <select aria-label="Periodo del resumen" value={periodDays}
              onChange={event => setPeriodDays(Number(event.currentTarget.value) as PeriodDays)}>
              <option value={7}>Últimos 7 días</option>
              <option value={30}>Últimos 30 días</option>
            </select>
          </label>
        </div>
        <p className="summary-range" aria-live="polite">
          <strong>{data ? formatUtc(data.period.from) : formatUtc(period.from)}</strong>
          <span aria-hidden="true">→</span>
          <strong>{data ? formatUtc(data.period.to) : formatUtc(period.to)}</strong>
          <span className="summary-range-note">UTC · inicio incluido, fin excluido</span>
        </p>
      </header>

      {summary.isPending && <div className="summary-state" role="status">Cargando métricas archivadas…</div>}
      {summary.isError && (
        <div className="summary-state summary-state-error" role="alert">
          <div><h2>No se pudo cargar el resumen</h2><p>{summary.error.message}</p></div>
          <button className="summary-retry" type="button" onClick={() => void summary.refetch()}>
            <RefreshCw aria-hidden="true" size={15} /> Reintentar
          </button>
        </div>
      )}

      {data && (
        <>
          <div className="summary-metrics" aria-label="Métricas del periodo">
            <article className="summary-metric-card">
              <div className="summary-metric-icon"><MessageSquareText aria-hidden="true" size={18} /></div>
              <p>Entradas archivadas</p>
              <strong>{countFormatter.format(data.metrics.inboundMessages)}</strong>
              <span>Mensajes entrantes con secuencia durable</span>
            </article>
            <article className="summary-metric-card">
              <div className="summary-metric-icon"><UsersRound aria-hidden="true" size={18} /></div>
              <p>Conversaciones con entradas</p>
              <strong>{countFormatter.format(data.metrics.activeConversations)}</strong>
              <span>Conversaciones distintas con actividad entrante</span>
            </article>
            <article className="summary-metric-card">
              <div className="summary-metric-icon"><Bot aria-hidden="true" size={18} /></div>
              <p>Respuestas IA aceptadas</p>
              <strong>{countFormatter.format(data.metrics.acceptedAiReplies)}</strong>
              <span>Salidas aceptadas por el canal</span>
            </article>
            <article className="summary-metric-card">
              <div className="summary-metric-icon"><UserRound aria-hidden="true" size={18} /></div>
              <p>Respuestas humanas aceptadas</p>
              <strong>{countFormatter.format(data.metrics.acceptedHumanReplies)}</strong>
              <span>Envíos del operador aceptados por el canal</span>
            </article>
          </div>

          <section className="summary-channel-panel" aria-labelledby="summary-channels-title">
            <div className="summary-panel-heading">
              <div><h2 id="summary-channels-title">Actividad por canal</h2><p>Conteos dentro del periodo seleccionado.</p></div>
            </div>
            {data.byChannel.length === 0 ? <p className="summary-empty">No hay cuentas de canal en el archivo.</p> : (
              <div className="summary-table-wrap">
                <table className="summary-table">
                  <thead><tr>
                    <th scope="col">Canal</th><th scope="col">Entradas</th><th scope="col">Conversaciones</th>
                    <th scope="col">Respuestas IA</th><th scope="col">Respuestas humanas</th>
                  </tr></thead>
                  <tbody>{data.byChannel.map(channel => (
                    <tr key={channel.channel}>
                      <th scope="row">{channelLabel(channel.channel)}</th>
                      <td>{countFormatter.format(channel.inboundMessages)}</td>
                      <td>{countFormatter.format(channel.activeConversations)}</td>
                      <td>{countFormatter.format(channel.acceptedAiReplies)}</td>
                      <td>{countFormatter.format(channel.acceptedHumanReplies)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>

          <aside className="summary-coverage" aria-label="Cobertura del archivo">
            <strong>Cobertura disponible</strong>
            <p>{data.coverageStartAt
              ? `La entrada archivada más antigua disponible es del ${formatUtc(data.coverageStartAt)}.`
              : 'El archivo todavía no contiene entradas entrantes.'}
              {' '}Los conteos reflejan solo datos presentes en este archivo.
            </p>
          </aside>
          {data.metrics.inboundMessages === 0 && data.metrics.acceptedAiReplies === 0 && data.metrics.acceptedHumanReplies === 0 && (
            <p className="summary-no-activity">No hay actividad archivada en este periodo.</p>
          )}
        </>
      )}
    </section>
  );
}
