// @targets spec, package
// What a caller can do with the shapes a run hands back: read a typed result, walk the
// attempt records, read a quota view, and switch over a provider response without a
// default arm. The last one is the check that matters: an added `ProviderResponse` member
// has to break this file rather than fall through it silently.
import type { AttemptRecord, ProviderResponse, QuotaView, RunResult } from 'llmdispatch'

export function summaryOf(result: RunResult<{ summary: string }>): string {
  const suffix = result.usedFallback ? ' (fallback)' : ''
  return `${result.route.provider}/${result.route.model}${suffix}: ${result.data.summary}`
}

export function tokensOf(attempt: AttemptRecord): number {
  if (attempt.usage === null) return 0
  return attempt.usage.inputTokens + attempt.usage.outputTokens
}

export function statusOf(attempt: AttemptRecord): number | null {
  return attempt.status ?? null
}

export function headroom(view: QuotaView): string {
  return `${String(view.remaining)} of ${String(view.limit)} until ${view.resetsAt}`
}

export function textOf(response: ProviderResponse): string {
  switch (response.kind) {
    case 'complete':
      return response.text
    case 'truncated':
      return `${response.text}…`
    case 'refused':
      return ''
  }
}
