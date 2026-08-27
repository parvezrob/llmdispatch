import express from 'express'
import { LLMDispatchError } from 'llmdispatch'

import { SummarizeBody, ai } from './switch.js'

/** The mapping from the README's error table. */
const STATUS_BY_CODE = {
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

const app = express()
app.use(express.json({ limit: '1mb' }))

// Liveness only. `EXAMPLE_READY_TOKEN` is what the repository's `verify-examples` harness
// looks for; nothing in the example itself needs it.
app.get('/healthz', (_request, response) => {
  response.json({ ready: true, token: process.env.EXAMPLE_READY_TOKEN ?? null })
})

app.post('/summarize', async (request, response) => {
  const parsed = SummarizeBody.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: 'Bad request' })
    return
  }
  // Your auth belongs here: `subjectId` counts someone's quota, so it must be derived on
  // the server from the session and never read out of the request body.
  const subjectId = 'demo-user'

  // If the caller goes away, the work goes with it, since an abandoned request should not carry
  // on spending provider budget. `run` then ends in `ABORTED`. It is the RESPONSE that says
  // whether the client is still there: `request`'s own `close` fires as soon as its body has
  // been read, which is every request, not an abandoned one.
  const abandoned = new AbortController()
  response.on('close', () => {
    if (!response.writableEnded) abandoned.abort()
  })

  try {
    const result = await ai.run(
      'summarize',
      { input: parsed.data, subjectId },
      { signal: abandoned.signal },
    )
    response.json({
      data: result.data,
      provider: result.route.provider,
      model: result.route.model,
      usedFallback: result.usedFallback,
    })
  } catch (error) {
    if (error instanceof LLMDispatchError) {
      response.status(STATUS_BY_CODE[error.code] ?? 500).json({ error: error.code })
      return
    }
    // Anything else is a bug in this application's own callbacks.
    response.status(500).json({ error: 'Internal error' })
  }
})

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? '3000')

app.listen(port, host, () => {
  console.log(`summarize example listening on ${host}:${String(port)}`)
})
