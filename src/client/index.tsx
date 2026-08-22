import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  parseGarminAuthBeginRpcResult,
  parseGarminAuthStatusRpcResult,
  type GarminAuthBeginResult,
  type GarminAuthClientErrorCode,
  type GarminAuthPublicStatus,
} from './protocol'
import {
  releaseGarminAuthFlow,
  retainUnreleasedGarminAuthFlowId,
} from './flow-control'

const RPC_CHANNEL = '/garmin-auth'
const STATUS_POLL_MS = 750

type GarminClientContext = ClientContext & { connection: ConnectionHandle }
type GarminLoginRegion = 'cn' | 'global'

const REGION_DETAILS: Record<GarminLoginRegion, {
  domain: string
  label: string
}> = {
  cn: {
    domain: 'garmin.cn',
    label: '中国区',
  },
  global: {
    domain: 'garmin.com',
    label: '国际区',
  },
}

export const inject = ['slots', 'connection']

export function apply(ctx: GarminClientContext): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'garmin-connect-auth',
    order: 90,
    registrant: 'dsh-plugin-garmin-connect',
  }, () => <GarminAuthOverlay ctx={ctx} />))
}

function GarminAuthOverlay({ ctx }: { ctx: GarminClientContext }): ReactElement {
  const [open, setOpen] = useState(false)
  const [begin, setBegin] = useState<GarminAuthBeginResult>()
  const [status, setStatus] = useState<GarminAuthPublicStatus>()
  const [busy, setBusy] = useState(false)
  const [selectedRegion, setSelectedRegion] = useState<GarminLoginRegion>()
  const generation = useRef(0)
  const activeFlowId = useRef<string>()
  const beginRequest = useRef<AbortController>()

  const cancelFlow = useCallback((
    flowId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => releaseGarminAuthFlow(
    ctx.connection.rpc,
    flowId,
    signal,
  ), [ctx])

  const beginAuthentication = useCallback(async (region: GarminLoginRegion) => {
    if (!ctx.connection.isLoopback || busy || beginRequest.current) return
    const current = ++generation.current
    const previousFlowId = activeFlowId.current
    setSelectedRegion(region)
    setOpen(true)
    setBusy(true)
    setBegin(undefined)
    setStatus(undefined)
    const controller = new AbortController()
    beginRequest.current = controller
    try {
      if (previousFlowId) {
        const released = await cancelFlow(previousFlowId, controller.signal)
        if (generation.current !== current || controller.signal.aborted) return
        if (!released) {
          setBegin({ success: false, code: 'unavailable' })
          return
        }
        if (activeFlowId.current === previousFlowId) {
          activeFlowId.current = undefined
        }
      }
      if (generation.current !== current || controller.signal.aborted) return
      const result = parseGarminAuthBeginRpcResult(
        await ctx.connection.rpc.call(
          RPC_CHANNEL,
          'begin',
          { region },
          controller.signal,
        ),
      )
      if (generation.current !== current || controller.signal.aborted) {
        if (result.success) {
          const released = await cancelFlow(result.flowId)
          activeFlowId.current = retainUnreleasedGarminAuthFlowId(
            activeFlowId.current,
            result.flowId,
            released,
          )
        }
        return
      }
      setBegin(result)
      if (result.success) {
        activeFlowId.current = result.flowId
        setStatus('in_progress')
      }
    } catch {
      if (generation.current === current && !controller.signal.aborted) {
        setBegin({ success: false, code: 'unavailable' })
      }
    } finally {
      if (beginRequest.current === controller) beginRequest.current = undefined
      if (generation.current === current) setBusy(false)
    }
  }, [busy, cancelFlow, ctx])

  const closeAuthentication = useCallback(() => {
    generation.current += 1
    beginRequest.current?.abort()
    beginRequest.current = undefined
    const active = activeFlowId.current
    setOpen(false)
    setBegin(undefined)
    setStatus(undefined)
    setSelectedRegion(undefined)
    setBusy(false)
    if (active) {
      void cancelFlow(active).then(released => {
        if (released && activeFlowId.current === active) {
          activeFlowId.current = undefined
        }
      })
    }
  }, [cancelFlow])

  useEffect(() => () => {
    beginRequest.current?.abort()
    const active = activeFlowId.current
    if (active) void cancelFlow(active)
  }, [cancelFlow])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeAuthentication()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeAuthentication, open])

  useEffect(() => {
    if (!open || begin?.success !== true || isTerminal(status)) return
    const flowId = begin.flowId
    const current = generation.current
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      try {
        const result = parseGarminAuthStatusRpcResult(
          await ctx.connection.rpc.call(
            RPC_CHANNEL,
            'status',
            { flowId },
            controller.signal,
          ),
        )
        if (controller.signal.aborted || generation.current !== current) return
        if (!result.success) {
          setBegin(result)
          return
        }
        setStatus(result.status)
        if (isTerminal(result.status) && activeFlowId.current === flowId) {
          activeFlowId.current = undefined
        }
        if (!isTerminal(result.status)) {
          timer = setTimeout(() => void poll(), STATUS_POLL_MS)
        }
      } catch {
        if (!controller.signal.aborted && generation.current === current) {
          setBegin({ success: false, code: 'unavailable' })
        }
      }
    }

    timer = setTimeout(() => void poll(), STATUS_POLL_MS)
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [begin, ctx, open, status])

  if (!ctx.connection.isLoopback) {
    return (
      <div className="gca-launcher" style={badgeWrapStyle}>
        <style>{CLIENT_STYLES}</style>
        <button
          aria-label="登录 Garmin 中国区"
          className="gca-region-button"
          disabled
          title="Garmin 登录仅支持本机 DSH"
          style={{ ...regionButtonStyle, ...chinaButtonStyle, ...disabledButtonStyle }}
        >
          <span style={regionMarkStyle}>CN</span>
          <span className="gca-region-copy" style={regionCopyStyle}>
            <strong style={regionNameStyle}>国内账号</strong>
            <small style={regionDomainStyle}>garmin.cn</small>
          </span>
        </button>
        <button
          aria-label="登录 Garmin 国际区"
          className="gca-region-button"
          disabled
          title="Garmin 登录仅支持本机 DSH"
          style={{ ...regionButtonStyle, ...globalButtonStyle, ...disabledButtonStyle }}
        >
          <GlobeIcon />
          <span className="gca-region-copy" style={regionCopyStyle}>
            <strong style={regionNameStyle}>国际账号</strong>
            <small style={{ ...regionDomainStyle, color: 'rgba(255,255,255,.72)' }}>
              garmin.com
            </small>
          </span>
        </button>
      </div>
    )
  }

  const selected = selectedRegion ? REGION_DETAILS[selectedRegion] : undefined

  return (
    <div className="gca-launcher" style={badgeWrapStyle}>
      <style>{CLIENT_STYLES}</style>
      <button
        aria-label="登录 Garmin 中国区"
        className="gca-region-button"
        onClick={() => void beginAuthentication('cn')}
        style={{ ...regionButtonStyle, ...chinaButtonStyle }}
        title="登录 Garmin 中国区账号"
      >
        <span style={regionMarkStyle}>CN</span>
        <span className="gca-region-copy" style={regionCopyStyle}>
          <strong style={regionNameStyle}>国内账号</strong>
          <small style={regionDomainStyle}>garmin.cn</small>
        </span>
      </button>
      <button
        aria-label="登录 Garmin 国际区"
        className="gca-region-button"
        onClick={() => void beginAuthentication('global')}
        style={{ ...regionButtonStyle, ...globalButtonStyle }}
        title="登录 Garmin 国际区账号"
      >
        <GlobeIcon />
        <span className="gca-region-copy" style={regionCopyStyle}>
          <strong style={regionNameStyle}>国际账号</strong>
          <small style={{ ...regionDomainStyle, color: 'rgba(255,255,255,.72)' }}>
            garmin.com
          </small>
        </span>
      </button>
      {open && (
        <div className="gca-backdrop" role="presentation" style={backdropStyle} onMouseDown={event => {
          if (event.currentTarget === event.target) closeAuthentication()
        }}>
          <section
            aria-label={`Garmin Connect ${selected?.label ?? ''}登录`}
            aria-modal="true"
            className="gca-dialog"
            role="dialog"
            style={dialogStyle}
          >
            <header style={headerStyle}>
              <div style={headerIdentityStyle}>
                <div aria-hidden="true" style={brandMarkStyle}>
                  <GarminMark />
                </div>
                <div>
                  <div style={titleRowStyle}>
                    <strong style={titleStyle}>Garmin Connect</strong>
                    {selected && <span style={regionBadgeStyle}>{selected.label}</span>}
                  </div>
                  <div style={subtitleStyle}>
                    在 Garmin 官方页面完成登录与两步验证
                  </div>
                </div>
              </div>
              <div style={headerActionsStyle}>
                <span className="gca-security-badge" style={securityBadgeStyle}>
                  <LockIcon /> 凭据不会进入对话
                </span>
                <button
                  aria-label="关闭"
                  className="gca-close"
                  onClick={closeAuthentication}
                  style={closeStyle}
                  title="关闭登录"
                >
                  <CloseIcon />
                </button>
              </div>
            </header>
            <div style={bodyStyle}>
              {busy && <Status text={`正在连接 Garmin ${selected?.label ?? ''}…`} busy />}
              {begin?.success === false && (
                <ErrorStatus
                  code={begin.code}
                  onRetry={() => beginAuthentication(selectedRegion ?? 'global')}
                />
              )}
              {begin?.success === true && !isTerminal(status) && (
                <div style={frameShellStyle}>
                  <div style={frameToolbarStyle}>
                    <span style={officialDotStyle} />
                    <span style={frameDomainStyle}>{selected?.domain}</span>
                    <span style={officialBadgeStyle}>Garmin 官方页面</span>
                  </div>
                  <iframe
                    referrerPolicy="no-referrer"
                    sandbox="allow-forms allow-same-origin allow-scripts allow-storage-access-by-user-activation"
                    src={begin.bridgeUrl}
                    style={iframeStyle}
                    title={`Garmin ${selected?.label ?? ''}安全登录`}
                  />
                </div>
              )}
              {status === 'succeeded' && (
                <Status text="登录成功，会话已安全保存到本机。" success />
              )}
              {status === 'failed' && <Status text="Garmin 登录失败，请重新选择区域后再试。" error />}
              {status === 'cancelled' && <Status text="登录已取消。" />}
              {status === 'expired' && <Status text="登录页面已过期，请重新选择区域。" error />}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function ErrorStatus({
  code,
  onRetry,
}: {
  code: GarminAuthClientErrorCode
  onRetry(): Promise<void>
}): ReactElement {
  const message = code === 'not_local'
      ? '此功能只能在本机 DSH 页面使用。'
      : code === 'configuration'
      ? '请先配置 Garmin 邮箱，并确认所选区域与 GARMIN_REGION 一致。'
      : code === 'busy'
        ? '已有一个 Garmin 登录正在进行。'
        : '暂时无法启动 Garmin 登录。'
  return (
    <div style={statusStyle}>
      <div aria-hidden="true" style={errorIconStyle}>!</div>
      <p>{message}</p>
      <button className="gca-retry" onClick={() => void onRetry()} style={retryButtonStyle}>
        重试
      </button>
    </div>
  )
}

function Status({
  text,
  busy = false,
  error = false,
  success = false,
}: {
  text: string
  busy?: boolean
  error?: boolean
  success?: boolean
}): ReactElement {
  const color = success
    ? 'var(--dsw-alias-state-success-primary, #087443)'
    : error
      ? 'var(--dsw-alias-state-error-primary, #b42318)'
      : 'var(--dsw-alias-label-primary, #334155)'
  return (
    <div style={{ ...statusStyle, color }}>
      {busy
        ? <span aria-hidden="true" className="gca-spinner" style={spinnerStyle} />
        : (
          <div
            aria-hidden="true"
            style={{
              ...statusIconStyle,
              background: success ? '#e8f8f0' : error ? '#fef0ef' : '#eef4fb',
              color,
            }}
          >
            {success ? '✓' : error ? '!' : 'i'}
          </div>
        )}
      <strong style={statusTextStyle}>{text}</strong>
      <span style={statusHintStyle}>你可以随时关闭此窗口，凭据不会保存到 DSH 页面。</span>
    </div>
  )
}

function GlobeIcon(): ReactElement {
  return (
    <svg aria-hidden="true" height="20" viewBox="0 0 24 24" width="20">
      <circle cx="12" cy="12" fill="none" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 12h17M12 3c2.2 2.45 3.3 5.45 3.3 9S14.2 18.55 12 21M12 3C9.8 5.45 8.7 8.45 8.7 12S9.8 18.55 12 21" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </svg>
  )
}

function GarminMark(): ReactElement {
  return (
    <svg aria-hidden="true" height="24" viewBox="0 0 32 24" width="32">
      <path d="M16 3 29 20H3L16 3Z" fill="currentColor" />
    </svg>
  )
}

function LockIcon(): ReactElement {
  return (
    <svg aria-hidden="true" height="13" viewBox="0 0 24 24" width="13">
      <path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  )
}

function CloseIcon(): ReactElement {
  return (
    <svg aria-hidden="true" height="20" viewBox="0 0 24 24" width="20">
      <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  )
}

function isTerminal(status: GarminAuthPublicStatus | undefined): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'expired'
}

const badgeWrapStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  pointerEvents: 'auto',
  position: 'fixed',
  right: 16,
  top: 12,
  zIndex: 70,
}
const regionButtonStyle: CSSProperties = {
  alignItems: 'center',
  border: '1px solid transparent',
  borderRadius: 12,
  boxShadow: '0 8px 24px rgba(15, 23, 42, .12)',
  cursor: 'pointer',
  display: 'flex',
  gap: 9,
  justifyContent: 'center',
  minHeight: 44,
  minWidth: 124,
  padding: '7px 12px',
  transition: 'box-shadow .18s ease, transform .18s ease, border-color .18s ease',
}
const chinaButtonStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  borderColor: 'var(--dsw-alias-border-l2, #dce4ed)',
  color: 'var(--dsw-alias-label-primary, #2a3342)',
}
const globalButtonStyle: CSSProperties = {
  background: 'linear-gradient(145deg, #087cc1 0%, #075a9c 100%)',
  borderColor: 'rgba(255,255,255,.22)',
  color: '#fff',
}
const regionMarkStyle: CSSProperties = {
  alignItems: 'center',
  background: '#fff0ee',
  border: '1px solid #f6cbc5',
  borderRadius: 7,
  color: '#c12d24',
  display: 'inline-flex',
  fontSize: 10,
  fontWeight: 800,
  height: 22,
  justifyContent: 'center',
  letterSpacing: '.04em',
  width: 28,
}
const regionCopyStyle: CSSProperties = {
  alignItems: 'flex-start',
  display: 'flex',
  flexDirection: 'column',
  lineHeight: 1.15,
}
const regionNameStyle: CSSProperties = { fontSize: 13, fontWeight: 720 }
const regionDomainStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #7a8798)',
  fontSize: 9.5,
  fontWeight: 550,
  marginTop: 3,
}
const disabledButtonStyle: CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.55,
}
const backdropStyle: CSSProperties = {
  alignItems: 'center',
  backdropFilter: 'blur(8px)',
  background: 'var(--dsw-alias-bg-mask-1, rgba(8, 18, 34, 0.66))',
  display: 'flex',
  inset: 0,
  justifyContent: 'center',
  padding: 20,
  position: 'fixed',
  zIndex: 100,
}
const dialogStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1, #f4f7fb)',
  border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.78))',
  borderRadius: 20,
  boxShadow: '0 32px 100px rgba(4, 14, 30, 0.42)',
  maxHeight: 'min(860px, calc(100vh - 32px))',
  maxWidth: 780,
  overflow: 'hidden',
  width: 'min(780px, calc(100vw - 32px))',
}
const headerStyle: CSSProperties = {
  alignItems: 'center',
  background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #e5ebf2)',
  display: 'flex',
  justifyContent: 'space-between',
  padding: '17px 20px',
}
const headerIdentityStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: 12,
  minWidth: 0,
}
const brandMarkStyle: CSSProperties = {
  alignItems: 'center',
  background: 'linear-gradient(145deg, #0785c9, #075a9c)',
  borderRadius: 12,
  boxShadow: '0 7px 18px rgba(7, 111, 177, .24)',
  color: '#fff',
  display: 'flex',
  flex: '0 0 auto',
  height: 42,
  justifyContent: 'center',
  width: 42,
}
const titleRowStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
}
const titleStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary, #101828)',
  fontSize: 17,
  letterSpacing: '-.015em',
}
const regionBadgeStyle: CSSProperties = {
  background: '#eaf4fb',
  border: '1px solid #c8e3f3',
  borderRadius: 999,
  color: '#08669e',
  fontSize: 10,
  fontWeight: 750,
  padding: '3px 7px',
}
const subtitleStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #66758a)',
  fontSize: 11.5,
  marginTop: 4,
}
const headerActionsStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: 10,
}
const securityBadgeStyle: CSSProperties = {
  alignItems: 'center',
  background: '#edf8f3',
  border: '1px solid #ceeadd',
  borderRadius: 999,
  color: '#18704b',
  display: 'inline-flex',
  fontSize: 10.5,
  fontWeight: 650,
  gap: 5,
  padding: '5px 8px',
}
const closeStyle: CSSProperties = {
  alignItems: 'center',
  background: 'var(--dsw-alias-button-tool-bar-fill, #f4f6f8)',
  border: '1px solid var(--dsw-alias-border-l2, #e2e7ed)',
  borderRadius: 9,
  color: 'var(--dsw-alias-label-secondary, #516071)',
  cursor: 'pointer',
  display: 'flex',
  height: 34,
  justifyContent: 'center',
  padding: 0,
  transition: 'background .18s ease, color .18s ease',
  width: 34,
}
const bodyStyle: CSSProperties = {
  padding: 14,
}
const frameShellStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  border: '1px solid var(--dsw-alias-border-l2, #dce4ed)',
  borderRadius: 14,
  boxShadow: '0 8px 26px rgba(35, 55, 80, .08)',
  overflow: 'hidden',
}
const frameToolbarStyle: CSSProperties = {
  alignItems: 'center',
  background: 'var(--dsw-alias-bg-layer-2, #f9fbfd)',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #e4eaf1)',
  display: 'flex',
  gap: 7,
  minHeight: 35,
  padding: '0 12px',
}
const officialDotStyle: CSSProperties = {
  background: '#1a9b61',
  borderRadius: 999,
  boxShadow: '0 0 0 3px #e0f5ea',
  height: 7,
  width: 7,
}
const frameDomainStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #526174)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5,
}
const officialBadgeStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary, #718096)',
  fontSize: 10,
  marginLeft: 'auto',
}
const iframeStyle: CSSProperties = {
  background: '#fff',
  border: 0,
  display: 'block',
  height: 'min(630px, calc(100vh - 183px))',
  width: '100%',
}
const statusStyle: CSSProperties = {
  alignItems: 'center',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  border: '1px solid var(--dsw-alias-border-l2, #e0e7ef)',
  borderRadius: 14,
  boxShadow: '0 8px 26px rgba(35, 55, 80, .06)',
  color: 'var(--dsw-alias-label-primary, #334155)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  justifyContent: 'center',
  minHeight: 'min(630px, calc(100vh - 183px))',
  padding: 28,
  textAlign: 'center',
}
const retryButtonStyle: CSSProperties = {
  background: 'var(--dsw-alias-button-primary-fill, #0878ba)',
  border: 0,
  borderRadius: 9,
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
  padding: '9px 18px',
}
const errorIconStyle: CSSProperties = {
  alignItems: 'center',
  background: '#fef0ef',
  borderRadius: 999,
  color: '#b42318',
  display: 'flex',
  fontSize: 18,
  fontWeight: 800,
  height: 44,
  justifyContent: 'center',
  width: 44,
}
const spinnerStyle: CSSProperties = {
  border: '3px solid #dbeaf4',
  borderRadius: '50%',
  borderTopColor: '#0878ba',
  height: 34,
  width: 34,
}
const statusIconStyle: CSSProperties = {
  alignItems: 'center',
  borderRadius: 999,
  display: 'flex',
  fontSize: 21,
  fontWeight: 800,
  height: 48,
  justifyContent: 'center',
  width: 48,
}
const statusTextStyle: CSSProperties = { fontSize: 14, fontWeight: 700 }
const statusHintStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #7a8798)',
  fontSize: 11,
  lineHeight: 1.6,
  maxWidth: 350,
}

const CLIENT_STYLES = `
  .gca-launcher, .gca-launcher * { box-sizing: border-box; }
  @keyframes gca-spin { to { transform: rotate(360deg); } }
  @keyframes gca-enter {
    from { opacity: 0; transform: translateY(8px) scale(.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .gca-spinner { animation: gca-spin .8s linear infinite; }
  .gca-dialog { animation: gca-enter .2s ease-out; }
  .gca-region-button:not(:disabled):hover {
    box-shadow: 0 12px 30px rgba(15, 23, 42, .18) !important;
    transform: translateY(-1px);
  }
  .gca-region-button:not(:disabled):active { transform: translateY(0); }
  .gca-region-button:focus-visible,
  .gca-close:focus-visible,
  .gca-retry:focus-visible {
    outline: 3px solid rgba(21, 133, 203, .34);
    outline-offset: 2px;
  }
  .gca-close:hover {
    background: var(--dsw-alias-button-tool-bar-hover, #eaf0f5) !important;
    color: var(--dsw-alias-label-primary, #182230) !important;
  }
  .gca-retry:hover {
    background: var(--dsw-alias-button-primary-hover, #076ba6) !important;
  }
  @media (max-width: 640px) {
    .gca-launcher { right: 8px !important; top: 8px !important; gap: 6px !important; }
    .gca-region-button { min-width: 0 !important; padding: 8px 10px !important; }
    .gca-region-copy small { display: none; }
    .gca-backdrop { padding: 8px !important; }
    .gca-dialog {
      border-radius: 15px !important;
      max-height: calc(100vh - 16px) !important;
      width: calc(100vw - 16px) !important;
    }
    .gca-security-badge { display: none !important; }
  }
  @media (prefers-reduced-motion: reduce) {
    .gca-dialog, .gca-spinner, .gca-region-button { animation: none !important; transition: none !important; }
  }
`
