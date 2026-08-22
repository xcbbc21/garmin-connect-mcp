import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
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
import {
  CLIENT_STYLES,
  backdropStyle,
  badgeWrapStyle,
  bodyStyle,
  brandMarkStyle,
  chinaButtonStyle,
  closeStyle,
  dialogStyle,
  disabledButtonStyle,
  errorIconStyle,
  frameDomainStyle,
  frameShellStyle,
  frameToolbarStyle,
  globalButtonStyle,
  headerActionsStyle,
  headerIdentityStyle,
  headerStyle,
  iframeStyle,
  officialBadgeStyle,
  officialDotStyle,
  regionBadgeStyle,
  regionButtonStyle,
  regionCopyStyle,
  regionDomainStyle,
  regionMarkStyle,
  regionNameStyle,
  retryButtonStyle,
  securityBadgeStyle,
  spinnerStyle,
  statusHintStyle,
  statusIconStyle,
  statusStyle,
  statusTextStyle,
  subtitleStyle,
  titleRowStyle,
  titleStyle,
} from './styles'

const RPC_CHANNEL = '/garmin-auth'
const STATUS_POLL_MS = 750

type GarminClientContext = ClientContext & { connection: ConnectionHandle }
type GarminLoginRegion = 'cn' | 'global'

const LOGIN_REGIONS = ['cn', 'global'] as const
const REGION_DETAILS: Record<GarminLoginRegion, {
  accountLabel: string
  domain: string
  label: string
}> = {
  cn: {
    accountLabel: '国内账号',
    domain: 'garmin.cn',
    label: '中国区',
  },
  global: {
    accountLabel: '国际账号',
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
        {LOGIN_REGIONS.map(region => renderRegionLoginButton(region, true))}
      </div>
    )
  }

  const selected = selectedRegion ? REGION_DETAILS[selectedRegion] : undefined

  return (
    <div className="gca-launcher" style={badgeWrapStyle}>
      <style>{CLIENT_STYLES}</style>
      {LOGIN_REGIONS.map(region => renderRegionLoginButton(
        region,
        false,
        value => void beginAuthentication(value),
      ))}
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
              {busy && (
                <Status
                  text={`正在连接 Garmin ${selected?.label ?? ''}…`}
                  variant="busy"
                />
              )}
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
                <Status text="登录成功，会话已安全保存到本机。" variant="success" />
              )}
              {status === 'failed' && (
                <Status text="Garmin 登录失败，请重新选择区域后再试。" variant="error" />
              )}
              {status === 'cancelled' && <Status text="登录已取消。" />}
              {status === 'expired' && (
                <Status text="登录页面已过期，请重新选择区域。" variant="error" />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function renderRegionLoginButton(
  region: GarminLoginRegion,
  disabled: boolean,
  onLogin?: (region: GarminLoginRegion) => void,
): ReactElement {
  const details = REGION_DETAILS[region]
  const isChina = region === 'cn'
  return (
    <button
      aria-label={`登录 Garmin ${details.label}`}
      className="gca-region-button"
      disabled={disabled}
      key={region}
      onClick={onLogin ? () => onLogin(region) : undefined}
      style={{
        ...regionButtonStyle,
        ...(isChina ? chinaButtonStyle : globalButtonStyle),
        ...(disabled ? disabledButtonStyle : {}),
      }}
      title={disabled
        ? 'Garmin 登录仅支持本机 DSH'
        : `登录 Garmin ${details.label}账号`}
    >
      {isChina ? <span style={regionMarkStyle}>CN</span> : <GlobeIcon />}
      <span className="gca-region-copy" style={regionCopyStyle}>
        <strong style={regionNameStyle}>{details.accountLabel}</strong>
        <small style={{
          ...regionDomainStyle,
          ...(!isChina ? { color: 'rgba(255,255,255,.72)' } : {}),
        }}>
          {details.domain}
        </small>
      </span>
    </button>
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
  variant = 'info',
}: {
  text: string
  variant?: 'busy' | 'error' | 'info' | 'success'
}): ReactElement {
  const color = variant === 'success'
    ? 'var(--dsw-alias-state-success-primary, #087443)'
    : variant === 'error'
      ? 'var(--dsw-alias-state-error-primary, #b42318)'
      : 'var(--dsw-alias-label-primary, #334155)'
  return (
    <div style={{ ...statusStyle, color }}>
      {variant === 'busy'
        ? <span aria-hidden="true" className="gca-spinner" style={spinnerStyle} />
        : (
          <div
            aria-hidden="true"
            style={{
              ...statusIconStyle,
              background: variant === 'success'
                ? '#e8f8f0'
                : variant === 'error'
                  ? '#fef0ef'
                  : '#eef4fb',
              color,
            }}
          >
            {variant === 'success' ? '✓' : variant === 'error' ? '!' : 'i'}
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
