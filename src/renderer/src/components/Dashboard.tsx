import { type JSX } from 'react'
import type { SessionStatus } from '../api'
import type { SessionState } from '../types'
import { modeLabel, modelLabel } from '../types'
import { useT } from '../i18n'

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return '0s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

const CONTEXT_LIMIT = 200_000

interface Props {
  session: SessionState
  status: SessionStatus | null
  onClose: () => void
}

export default function Dashboard({ session, status: s, onClose }: Props): JSX.Element {
  const t = useT()
  const ctx = s ? s.cacheRead + s.cacheWrite + s.tokensIn : 0
  const ctxPct = Math.min(100, Math.round((ctx / CONTEXT_LIMIT) * 100))
  const toolRank = s ? Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 4) : []
  const toolAll = s
    ? Object.entries(s.toolCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([n, c]) => `${n}×${c}`)
        .join(' · ')
    : ''

  return (
    <div className="dashbar">
      <span className="dash-tag" title={t('dash.tagTip')}>
        📊
      </span>
      {!s ? (
        <span className="dash-none">
          {session.status === 'exited' ? t('dash.exitedNote') : t('dash.waiting')}
        </span>
      ) : (
        <>
          <span className="dash-item" title={t('dash.modeTip', { mode: modeLabel(session.mode, t) })}>
            <span className="dash-k">{t('dash.kModel')}</span>
            <span className="dash-v strong">{modelLabel(s.model, t)}</span>
          </span>
          {s.tool && (
            <span className="dash-item grow" title={s.toolDetail}>
              <span className="dash-k">{t('dash.kAction')}</span>
              <span className="dash-v">
                {s.tool}
                {s.toolDetail ? ` · ${s.toolDetail}` : ''}
              </span>
            </span>
          )}
          <span className="dash-item" title={t('dash.tokensTip', { tin: s.tokensIn, tout: s.tokensOut })}>
            <span className="dash-v strong">↑{fmtTokens(s.tokensIn)}</span>
            <span className="dash-v">↓{fmtTokens(s.tokensOut)}</span>
          </span>
          <span className="dash-item" title={t('dash.cacheTip', { r: s.cacheRead, w: s.cacheWrite })}>
            <span className="dash-k">{t('dash.kCache')}</span>
            <span className="dash-v">
              {fmtTokens(s.cacheRead)}/{fmtTokens(s.cacheWrite)}
            </span>
          </span>
          <span className="dash-item" title={t('dash.costTip')}>
            <span className="dash-k">{t('dash.kCost')}</span>
            <span className="dash-v cost">${s.costUsd.toFixed(4)}</span>
          </span>
          <span className="dash-item" title={t('dash.ctxTip')}>
            <span className="ctx-bar">
              <span className="ctx-fill" style={{ width: `${ctxPct}%` }} />
            </span>
            <span className="dash-v">{ctxPct}%</span>
          </span>
          <span className="dash-item" title={t('dash.turnsTip')}>
            <span className="dash-v">{t('dash.turns', { n: s.turns })}</span>
            <span className="dash-v">{fmtDuration(s.durationMs)}</span>
            {s.tokensOut > 0 && s.durationMs > 0 && (
              <span className="dash-v">{Math.round(s.tokensOut / (s.durationMs / 1000))} tok/s</span>
            )}
          </span>
          {toolRank.length > 0 && (
            <span className="dash-item" title={t('dash.toolsTip', { n: s.toolCalls, list: toolAll })}>
              {toolRank.map(([name, count]) => (
                <span key={name} className="tool-chip">
                  {name}×{count}
                </span>
              ))}
            </span>
          )}
        </>
      )}
      <span className="dash-close" onClick={onClose} title={t('dash.close')}>
        ×
      </span>
    </div>
  )
}
