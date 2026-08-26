export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Liveness only. `EXAMPLE_READY_TOKEN` is what the repository's `verify-examples` harness
// looks for; nothing in the example itself needs it.
export function GET(): Response {
  return Response.json({ ready: true, token: process.env.EXAMPLE_READY_TOKEN ?? null })
}
