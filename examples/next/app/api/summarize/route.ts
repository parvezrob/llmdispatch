import { LLMSwitchError } from 'llmswitch'

import { SummarizeBody, ai } from '../../../lib/switch'

/** The mapping from the README's error table. */
const STATUS_BY_CODE: Record<LLMSwitchError['code'], number> = {
  INVALID_INPUT: 400,
  MISSING_SUBJECT: 500,
  CONFIG_STORE_UNAVAILABLE: 503,
  INVALID_CONFIG: 500,
  QUOTA_EXCEEDED: 429,
  USAGE_STORE_UNAVAILABLE: 503,
  ABORTED: 499,
  PROVIDER_FAILED: 502,
  OUTPUT_REJECTED: 502,
}

// The switch holds in-memory stores, so this handler needs the Node.js runtime and must
// not be rendered at build time.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }
  const parsed = SummarizeBody.safeParse(body)
  if (!parsed.success) return Response.json({ error: 'Bad request' }, { status: 400 })
  // Your auth belongs here: `subjectId` counts someone's quota, so it must be derived on
  // the server from the session and never read out of the request body.
  const subjectId = 'demo-user'

  try {
    // If the caller goes away, the work goes with it — an abandoned request should not
    // carry on spending provider budget. `run` then ends in `ABORTED`.
    const result = await ai.run(
      'summarize',
      { input: parsed.data, subjectId },
      { signal: request.signal },
    )
    return Response.json({
      data: result.data,
      provider: result.route.provider,
      model: result.route.model,
      usedFallback: result.usedFallback,
    })
  } catch (error) {
    if (error instanceof LLMSwitchError) {
      return Response.json({ error: error.code }, { status: STATUS_BY_CODE[error.code] })
    }
    // Anything else is a bug in this application's own callbacks.
    return Response.json({ error: 'Internal error' }, { status: 500 })
  }
}
