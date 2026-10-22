import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RadioTower, RefreshCw, ShieldCheck, Smartphone, Wifi, WifiOff } from 'lucide-react';
import { getAccounts, getSession } from '../inbox/api';
import {
  accountStatusLabel,
  getPairingStatus,
  getTelegramSettingsMeta,
  refreshQr,
  requestPairingCode,
  saveTelegramSettings,
  type QrState
} from './api';

function asError(value: unknown) {
  return value instanceof Error ? value : new Error('No se pudo completar la operación.');
}

function timeLabel(timestamp: number | null) {
  return timestamp === null ? null : new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function readQrState(raw: unknown): QrState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const qr = typeof value.qr === 'string' && value.qr.startsWith('data:image/') ? value.qr : null;
  return {
    qr,
    issuedAt: typeof value.issuedAt === 'number' ? value.issuedAt : null,
    expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : null,
    expired: value.expired === true,
    session: value.session === true
  };
}

function statusTone(status: string) {
  return status === 'connected' ? 'is-connected' : status === 'connecting' ? 'is-connecting' : 'is-offline';
}

export function ChannelsPage() {
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [qrState, setQrState] = useState<QrState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionQuery = useQuery({
    queryKey: ['channels', 'session'],
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000
  });
  const canManage = sessionQuery.data?.actor.capabilities.includes('admin:write') === true;
  const accountsQuery = useQuery({
    queryKey: ['channels', 'accounts'],
    queryFn: ({ signal }) => getAccounts(signal),
    enabled: sessionQuery.isSuccess,
    refetchInterval: 15_000,
    staleTime: 5_000
  });
  const pairingQuery = useQuery({
    queryKey: ['channels', 'pairing'],
    queryFn: ({ signal }) => getPairingStatus(signal),
    enabled: canManage,
    refetchInterval: query => query.state.data?.active ? 2_000 : false,
    staleTime: 0
  });
  const telegramMetaQuery = useQuery({
    queryKey: ['channels', 'telegram-meta'],
    queryFn: ({ signal }) => getTelegramSettingsMeta(signal),
    enabled: canManage,
    staleTime: 15_000
  });

  const pairingMutation = useMutation({
    mutationFn: async (request: { kind: 'qr' } | { kind: 'code'; phone: string }) =>
      request.kind === 'qr' ? refreshQr() : requestPairingCode(request.phone),
    onSuccess: async result => {
      setError(null);
      if (!result.success) {
        setNotice(null);
        setError(result.needsRestart
          ? 'El gateway no estaba activo; revisa el estado del servicio antes de vincular.'
          : 'No se pudo iniciar: puede haber otro método de vinculación activo o una solicitud pendiente.');
      } else {
        setNotice(result.code ? 'Código solicitado. Confirma el estado que aparece abajo.' : 'Solicitud enviada. El QR aparecerá aquí cuando Baileys lo emita.');
      }
      await queryClient.invalidateQueries({ queryKey: ['channels', 'pairing'] });
    },
    onError: value => { setNotice(null); setError(asError(value).message); }
  });

  const telegramMutation = useMutation({
    mutationFn: ({ disconnect }: { disconnect: boolean }) => saveTelegramSettings(disconnect ? '' : token.trim(), disconnect ? '' : chatId.trim()),
    onSuccess: async (success, variables) => {
      setError(null);
      if (!success) { setNotice(null); setError('No se pudo guardar la configuración de Telegram.'); return; }
      setToken('');
      setChatId('');
      setNotice(variables.disconnect
        ? 'Telegram quedó desconectado.'
        : 'Configuración guardada. El token se borró del formulario.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['channels', 'telegram-meta'] }),
        queryClient.invalidateQueries({ queryKey: ['channels', 'accounts'] })
      ]);
    },
    onError: value => { setNotice(null); setError(asError(value).message); }
  });

  const pairing = pairingQuery.data;
  const whatsappAccount = accountsQuery.data?.items.find(account => account.channel === 'whatsapp');
  const telegramAccount = accountsQuery.data?.items.find(account => account.channel === 'telegram');
  const whatsappConnected = whatsappAccount?.status === 'connected';
  const activeQr = pairing?.active === true && pairing.method === 'qr';
  const activeCode = pairing?.active === true && pairing.method === 'code';
  const qrSeconds = qrState?.expiresAt ? Math.max(0, Math.ceil((qrState.expiresAt - now) / 1000)) : null;
  const codeExpired = pairing?.expired === true || (pairing?.expiresAt !== null && pairing?.expiresAt !== undefined && now >= pairing.expiresAt);

  useEffect(() => {
    if (pairing?.method === 'code' && pairing.phone) setPhone(pairing.phone);
  }, [pairing?.method, pairing?.phone]);

  useEffect(() => {
    if (!canManage || !activeQr) return;
    setQrState(null);
    const source = new EventSource('/api/qr');
    source.onmessage = event => {
      try {
        const state = readQrState(JSON.parse(event.data));
        if (state) setQrState(state);
      } catch {
        setQrState(null);
      }
    };
    return () => source.close();
  }, [canManage, activeQr]);

  useEffect(() => {
    if (!pairing?.expiresAt && !qrState?.expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing?.expiresAt, qrState?.expiresAt]);

  function startQr() {
    setNotice(null);
    setError(null);
    setQrState(null);
    pairingMutation.mutate({ kind: 'qr' });
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pairingMutation.isPending || !/\d{9,}/.test(phone.replace(/\D/g, ''))) return;
    setNotice(null);
    setError(null);
    setQrState(null);
    pairingMutation.mutate({ kind: 'code', phone });
  }

  function submitTelegram(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim() || !/^-?[1-9]\d*$/.test(chatId.trim()) || telegramMutation.isPending) return;
    setNotice(null);
    setError(null);
    telegramMutation.mutate({ disconnect: false });
  }

  function disconnectTelegram() {
    if (!window.confirm('¿Desconectar Telegram y borrar su configuración guardada?')) return;
    setNotice(null);
    setError(null);
    telegramMutation.mutate({ disconnect: true });
  }

  return (
    <section className="channels-page" aria-labelledby="channels-title">
      <header className="channels-header">
        <div>
          <p className="eyebrow"><RadioTower aria-hidden="true" size={14} /> Transporte y vinculación</p>
          <h1 id="channels-title">Canales</h1>
          <p className="channels-subtitle">Estado de las conexiones y acceso a las herramientas de configuración.</p>
        </div>
        {sessionQuery.isPending ? <span className="channels-permission">Comprobando permisos…</span>
          : sessionQuery.isError ? <span className="channels-permission" role="alert">No se pudo comprobar tu sesión.</span>
            : !canManage && <span className="channels-permission">Vista de solo lectura</span>}
      </header>

      {error && <p className="channels-feedback is-error" role="alert">{error}</p>}
      {notice && <p className="channels-feedback is-notice" role="status">{notice}</p>}

      <div className="channels-grid">
        <article className="channel-card" aria-labelledby="whatsapp-title">
          <header className="channel-card-header">
            <div className="channel-card-icon whatsapp-channel-icon"><Smartphone aria-hidden="true" size={19} /></div>
            <div><p className="eyebrow">Atención al cliente</p><h2 id="whatsapp-title">WhatsApp</h2></div>
            <span className={`channel-status ${statusTone(whatsappAccount?.status ?? 'disconnected')}`}>
              {whatsappAccount?.status === 'connected' ? <Wifi aria-hidden="true" size={13} /> : <WifiOff aria-hidden="true" size={13} />}
              {accountStatusLabel(whatsappAccount?.status)}
            </span>
          </header>
          <p className="channel-description">Vincula la sesión que ya administra el gateway. El panel no inicia otra instancia de WhatsApp.</p>

          {accountsQuery.isError && <p className="channels-inline-error" role="alert">No se pudo consultar el estado del canal.</p>}
          {canManage && (
            <div className="pairing-panel">
              {whatsappConnected ? (
                <p className="pairing-summary" role="status">La cuenta está conectada. No hace falta iniciar pairing.</p>
              ) : pairingQuery.isPending ? (
                <p className="pairing-summary" role="status">Consultando si hay una vinculación en curso…</p>
              ) : pairingQuery.isError ? (
                <div className="pairing-summary is-error" role="alert">
                  No se pudo consultar el estado de pairing.
                  <button type="button" onClick={() => void pairingQuery.refetch()}><RefreshCw aria-hidden="true" size={14} /> Reintentar</button>
                </div>
              ) : activeQr ? (
                <div className="pairing-active">
                  <h3>Vinculación por QR</h3>
                  {qrState?.qr && !qrState.expired ? (
                    <figure className="pairing-qr">
                      <img src={qrState.qr} alt="Código QR de WhatsApp para vincular el dispositivo" />
                      <figcaption>{qrSeconds === null ? 'Escanea el código desde WhatsApp.' : qrSeconds > 0 ? `Disponible ${qrSeconds} s más.` : 'El código venció.'}</figcaption>
                    </figure>
                  ) : qrState?.expired ? (
                    <p className="pairing-summary" role="status">El QR venció. Solicita uno nuevo cuando quieras continuar.</p>
                  ) : (
                    <p className="pairing-summary" role="status">Esperando el QR del gateway…</p>
                  )}
                  {pairing?.expiresAt && <p className="pairing-expiry">Ventana abierta hasta las {timeLabel(pairing.expiresAt)}.</p>}
                </div>
              ) : activeCode ? (
                <div className="pairing-active">
                  <h3>Vinculación por código</h3>
                  {pairing?.busy ? <p className="pairing-summary" role="status">Solicitando el código…</p>
                    : pairing?.code && <p className="pairing-code" aria-label="Código de vinculación">{pairing.code}</p>}
                  <p className="pairing-expiry">
                    {codeExpired ? 'La ventana recomendada venció; puedes pedir un código nuevo.'
                      : pairing?.expiresAt ? `Úsalo antes de las ${timeLabel(pairing.expiresAt)}.` : 'Usa el código desde WhatsApp en el teléfono.'}
                  </p>
                </div>
              ) : (
                <p className="pairing-summary">No hay una solicitud de vinculación activa.</p>
              )}

              {!whatsappConnected && !activeCode && !activeQr && (
                <button className="channel-primary-button" type="button" disabled={pairingMutation.isPending || pairing?.busy === true}
                  onClick={startQr}>
                  {pairingMutation.isPending && pairingMutation.variables?.kind === 'qr' ? 'Solicitando QR…' : 'Solicitar QR'}
                </button>
              )}

              {!whatsappConnected && (!activeQr && (!activeCode || codeExpired)) && (
                <form className="pairing-code-form" onSubmit={submitCode}>
                  <label htmlFor="whatsapp-phone">Número con código de país</label>
                  <div className="pairing-code-fields">
                    <input id="whatsapp-phone" type="tel" autoComplete="tel" inputMode="tel" value={phone}
                      onChange={event => setPhone(event.currentTarget.value)} placeholder="56912345678" />
                    <button type="submit" disabled={pairingMutation.isPending || phone.replace(/\D/g, '').length < 9 || pairing?.busy === true}>
                      {pairingMutation.isPending && pairingMutation.variables?.kind === 'code' ? 'Solicitando…' : codeExpired ? 'Nuevo código' : 'Pedir código'}
                    </button>
                  </div>
                  <p>El gateway impide alternar entre QR y código mientras una solicitud sigue vigente.</p>
                </form>
              )}
            </div>
          )}
        </article>

        <article className="channel-card" aria-labelledby="telegram-title">
          <header className="channel-card-header">
            <div className="channel-card-icon telegram-channel-icon"><RadioTower aria-hidden="true" size={19} /></div>
            <div><p className="eyebrow">Notificaciones administrativas</p><h2 id="telegram-title">Telegram</h2></div>
            <span className={`channel-status ${statusTone(telegramAccount?.status ?? (telegramMetaQuery.data?.configured ? 'connected' : 'disconnected'))}`}>
              {telegramAccount?.status === 'connected' ? <Wifi aria-hidden="true" size={13} /> : <WifiOff aria-hidden="true" size={13} />}
              {telegramAccount ? accountStatusLabel(telegramAccount.status) : telegramMetaQuery.data?.configured ? 'Configurado' : 'Sin configurar'}
            </span>
          </header>
          <p className="channel-description">Este bot se reserva para administración; esta pantalla no ejecuta pruebas ni lo presenta como canal de atención a clientes.</p>

          {canManage && (
            <div className="telegram-admin-panel">
              {telegramMetaQuery.isPending ? <p className="pairing-summary" role="status">Consultando configuración…</p>
                : telegramMetaQuery.isError ? <p className="channels-inline-error" role="alert">No se pudo consultar la configuración.</p>
                  : <p className="telegram-config-state" role="status">
                    <ShieldCheck aria-hidden="true" size={15} />
                    {telegramMetaQuery.data?.configured
                      ? telegramMetaQuery.data.chatIdConfigured ? 'Token y destino guardados.' : 'Token guardado; falta definir el destino administrativo.'
                      : 'No hay credenciales guardadas.'}
                  </p>}
              <form className="telegram-settings-form" onSubmit={submitTelegram}>
                <label htmlFor="telegram-token">Token del bot</label>
                <input id="telegram-token" type="password" autoComplete="new-password" value={token}
                  onChange={event => setToken(event.currentTarget.value)} placeholder="Vuelve a ingresarlo para guardar" />
                <label htmlFor="telegram-chat-id">Chat ID administrativo</label>
                <input id="telegram-chat-id" type="text" inputMode="numeric" autoComplete="off" value={chatId}
                  onChange={event => setChatId(event.currentTarget.value)} placeholder="Identificador decimal exacto" />
                <p>Los valores guardados nunca se vuelven a leer ni aparecen en el navegador. Para cambiarlos, vuelve a ingresar ambos.</p>
                <div className="telegram-actions">
                  <button className="channel-primary-button" type="submit"
                    disabled={telegramMutation.isPending || !token.trim() || !/^-?[1-9]\d*$/.test(chatId.trim())}>
                    {telegramMutation.isPending && !telegramMutation.variables?.disconnect ? 'Guardando…' : 'Guardar configuración'}
                  </button>
                  {telegramMetaQuery.data?.configured && <button className="channel-secondary-button" type="button"
                    disabled={telegramMutation.isPending} onClick={disconnectTelegram}>
                    {telegramMutation.isPending && telegramMutation.variables?.disconnect ? 'Desconectando…' : 'Desconectar'}
                  </button>}
                </div>
              </form>
            </div>
          )}
        </article>
      </div>

      {!canManage && !sessionQuery.isPending && !sessionQuery.isError && (
        <p className="channels-readonly-note">El estado proviene de la API de lectura. Para vincular WhatsApp o editar Telegram se requiere el permiso administrativo del panel.</p>
      )}
    </section>
  );
}
