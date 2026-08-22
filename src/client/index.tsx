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

const RPC_CHANNEL = '/garmin-auth'
const STATUS_POLL_MS = 750

type GarminClientContext = ClientContext & { connection: ConnectionHandle }

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
  const generation = useRef(0)

  const beginAuthentication = useCallback(async () => {
    if (!ctx.connection.isLoopback || busy) return
    const current = ++generation.current
    setOpen(true)
    setBusy(true)
    setBegin(undefined)
    setStatus(undefined)
    try {
      const result = parseGarminAuthBeginRpcResult(
        await ctx.connection.rpc.call(RPC_CHANNEL, 'begin', {}),
      )
      if (generation.current !== current) return
      setBegin(result)
      if (result.success) setStatus('in_progress')
    } catch {
      if (generation.current === current) {
        setBegin({ success: false, code: 'unavailable' })
      }
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }, [busy, ctx])

  const closeAuthentication = useCallback(() => {
    generation.current += 1
    const active = begin?.success === true && status === 'in_progress'
      ? begin.flowId
      : undefined
    setOpen(false)
    setBegin(undefined)
    setStatus(undefined)
    setBusy(false)
    if (active) {
      void ctx.connection.rpc.call(RPC_CHANNEL, 'cancel', { flowId: active })
        .catch(() => undefined)
    }
  }, [begin, ctx, status])

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
      <div style={badgeWrapStyle}>
        <button disabled title="Garmin 登录仅支持本机 DSH" style={disabledButtonStyle}>
          Garmin 登录（仅本机）
        </button>
      </div>
    )
  }

  return (
    <div style={badgeWrapStyle}>
      <button onClick={() => void beginAuthentication()} style={buttonStyle}>
        Garmin 登录
      </button>
      {open && (
        <div role="presentation" style={backdropStyle} onMouseDown={event => {
          if (event.currentTarget === event.target) closeAuthentication()
        }}>
          <section
            aria-label="Garmin Connect 登录"
            aria-modal="true"
            role="dialog"
            style={dialogStyle}
          >
            <header style={headerStyle}>
              <div>
                <strong>Garmin Connect 登录</strong>
                <div style={subtitleStyle}>密码、验证码和 MFA 只输入在 Garmin 页面中</div>
              </div>
              <button aria-label="关闭" onClick={closeAuthentication} style={closeStyle}>×</button>
            </header>
            <div style={bodyStyle}>
              {busy && <Status text="正在准备安全登录页面…" />}
              {begin?.success === false && (
                <ErrorStatus code={begin.code} onRetry={beginAuthentication} />
              )}
              {begin?.success === true && !isTerminal(status) && (
                <iframe
                  referrerPolicy="no-referrer"
                  sandbox="allow-forms allow-same-origin allow-scripts allow-storage-access-by-user-activation"
                  src={begin.bridgeUrl}
                  style={iframeStyle}
                  title="Garmin 安全登录"
                />
              )}
              {status === 'succeeded' && (
                <Status text="登录成功，会话已安全保存到本机。" success />
              )}
              {status === 'failed' && <Status text="Garmin 登录失败，请重试。" />}
              {status === 'cancelled' && <Status text="登录已取消。" />}
              {status === 'expired' && <Status text="登录页面已过期，请重新开始。" />}
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
      ? '请先配置 Garmin 邮箱和区域。'
      : code === 'busy'
        ? '已有一个 Garmin 登录正在进行。'
        : '暂时无法启动 Garmin 登录。'
  return (
    <div style={statusStyle}>
      <p>{message}</p>
      <button onClick={() => void onRetry()} style={buttonStyle}>重试</button>
    </div>
  )
}

function Status({ text, success = false }: { text: string; success?: boolean }): ReactElement {
  return <div style={{ ...statusStyle, color: success ? '#166534' : '#334155' }}>{text}</div>
}

function isTerminal(status: GarminAuthPublicStatus | undefined): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'expired'
}

const badgeWrapStyle: CSSProperties = {
  pointerEvents: 'auto',
  position: 'fixed',
  right: 16,
  top: 14,
  zIndex: 70,
}
const buttonStyle: CSSProperties = {
  background: '#111827',
  border: 0,
  borderRadius: 9,
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 650,
  padding: '9px 13px',
}
const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  cursor: 'not-allowed',
  opacity: 0.55,
}
const backdropStyle: CSSProperties = {
  alignItems: 'center',
  background: 'rgba(15, 23, 42, 0.58)',
  display: 'flex',
  inset: 0,
  justifyContent: 'center',
  padding: 20,
  position: 'fixed',
  zIndex: 100,
}
const dialogStyle: CSSProperties = {
  background: '#fff',
  borderRadius: 14,
  boxShadow: '0 24px 80px rgba(15, 23, 42, 0.34)',
  maxHeight: 'min(820px, calc(100vh - 40px))',
  maxWidth: 720,
  overflow: 'hidden',
  width: 'min(720px, calc(100vw - 40px))',
}
const headerStyle: CSSProperties = {
  alignItems: 'flex-start',
  borderBottom: '1px solid #e5e7eb',
  display: 'flex',
  justifyContent: 'space-between',
  padding: '16px 18px',
}
const subtitleStyle: CSSProperties = { color: '#64748b', fontSize: 12, marginTop: 4 }
const closeStyle: CSSProperties = {
  background: 'transparent',
  border: 0,
  color: '#475569',
  cursor: 'pointer',
  fontSize: 26,
  lineHeight: 1,
}
const bodyStyle: CSSProperties = { minHeight: 480 }
const iframeStyle: CSSProperties = { border: 0, display: 'block', height: 650, width: '100%' }
const statusStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  justifyContent: 'center',
  minHeight: 480,
  padding: 28,
  textAlign: 'center',
}
