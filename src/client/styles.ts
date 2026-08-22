import type { CSSProperties } from 'react'

export const badgeWrapStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  pointerEvents: 'auto',
  position: 'fixed',
  right: 16,
  top: 12,
  zIndex: 70,
}

export const regionButtonStyle: CSSProperties = {
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

export const chinaButtonStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  borderColor: 'var(--dsw-alias-border-l2, #dce4ed)',
  color: 'var(--dsw-alias-label-primary, #2a3342)',
}

export const globalButtonStyle: CSSProperties = {
  background: 'linear-gradient(145deg, #087cc1 0%, #075a9c 100%)',
  borderColor: 'rgba(255,255,255,.22)',
  color: '#fff',
}

export const regionMarkStyle: CSSProperties = {
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

export const regionCopyStyle: CSSProperties = {
  alignItems: 'flex-start',
  display: 'flex',
  flexDirection: 'column',
  lineHeight: 1.15,
  minWidth: 0,
}

export const regionNameStyle: CSSProperties = { fontSize: 13, fontWeight: 720 }

export const regionDomainStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #7a8798)',
  fontSize: 9.5,
  fontWeight: 550,
  marginTop: 3,
  maxWidth: 184,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const disabledButtonStyle: CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.55,
}

export const backdropStyle: CSSProperties = {
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

export const dialogStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1, #f4f7fb)',
  border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.78))',
  borderRadius: 20,
  boxShadow: '0 32px 100px rgba(4, 14, 30, 0.42)',
  maxHeight: 'min(860px, calc(100vh - 32px))',
  maxWidth: 780,
  overflow: 'hidden',
  width: 'min(780px, calc(100vw - 32px))',
}

export const headerStyle: CSSProperties = {
  alignItems: 'center',
  background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #e5ebf2)',
  display: 'flex',
  justifyContent: 'space-between',
  padding: '17px 20px',
}

export const headerIdentityStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: 12,
  minWidth: 0,
}

export const brandMarkStyle: CSSProperties = {
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

export const titleRowStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
}

export const titleStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary, #101828)',
  fontSize: 17,
  letterSpacing: '-.015em',
}

export const regionBadgeStyle: CSSProperties = {
  background: '#eaf4fb',
  border: '1px solid #c8e3f3',
  borderRadius: 999,
  color: '#08669e',
  fontSize: 10,
  fontWeight: 750,
  padding: '3px 7px',
}

export const subtitleStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #66758a)',
  fontSize: 11.5,
  marginTop: 4,
}

export const headerActionsStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: 10,
}

export const securityBadgeStyle: CSSProperties = {
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

export const closeStyle: CSSProperties = {
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

export const bodyStyle: CSSProperties = { padding: 14 }

export const frameShellStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  border: '1px solid var(--dsw-alias-border-l2, #dce4ed)',
  borderRadius: 14,
  boxShadow: '0 8px 26px rgba(35, 55, 80, .08)',
  overflow: 'hidden',
}

export const frameToolbarStyle: CSSProperties = {
  alignItems: 'center',
  background: 'var(--dsw-alias-bg-layer-2, #f9fbfd)',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #e4eaf1)',
  display: 'flex',
  gap: 7,
  minHeight: 35,
  padding: '0 12px',
}

export const officialDotStyle: CSSProperties = {
  background: '#1a9b61',
  borderRadius: 999,
  boxShadow: '0 0 0 3px #e0f5ea',
  height: 7,
  width: 7,
}

export const frameDomainStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #526174)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5,
}

export const officialBadgeStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary, #718096)',
  fontSize: 10,
  marginLeft: 'auto',
}

export const iframeStyle: CSSProperties = {
  background: '#fff',
  border: 0,
  display: 'block',
  height: 'min(630px, calc(100vh - 183px))',
  width: '100%',
}

export const statusStyle: CSSProperties = {
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

export const retryButtonStyle: CSSProperties = {
  background: 'var(--dsw-alias-button-primary-fill, #0878ba)',
  border: 0,
  borderRadius: 9,
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
  padding: '9px 18px',
}

export const errorIconStyle: CSSProperties = {
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

export const spinnerStyle: CSSProperties = {
  border: '3px solid #dbeaf4',
  borderRadius: '50%',
  borderTopColor: '#0878ba',
  height: 34,
  width: 34,
}

export const statusIconStyle: CSSProperties = {
  alignItems: 'center',
  borderRadius: 999,
  display: 'flex',
  fontSize: 21,
  fontWeight: 800,
  height: 48,
  justifyContent: 'center',
  width: 48,
}

export const statusTextStyle: CSSProperties = { fontSize: 14, fontWeight: 700 }

export const statusHintStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #7a8798)',
  fontSize: 11,
  lineHeight: 1.6,
  maxWidth: 350,
}

export const CLIENT_STYLES = `
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
    .gca-region-button[data-authenticated="true"] .gca-region-copy small {
      display: block;
      max-width: 118px !important;
    }
    .gca-backdrop { padding: 8px !important; }
    .gca-dialog {
      border-radius: 15px !important;
      max-height: calc(100vh - 16px) !important;
      width: calc(100vw - 16px) !important;
    }
    .gca-security-badge { display: none !important; }
  }
  @media (prefers-reduced-motion: reduce) {
    .gca-dialog, .gca-spinner, .gca-region-button {
      animation: none !important;
      transition: none !important;
    }
  }
`
