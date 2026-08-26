/**
 * The redirect-exfiltration fixture (spec §5c/§8, plan §2 box 1): a real `fetch` against a
 * local two-endpoint `node:http` pair, source answering 302 to target. Proves what
 * `redirect: 'error'` does under the real runtime — no scripted fetch can show this.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { ProviderError } from '../../../src/errors'
import { openaiCompatible } from '../../../src/providers/openai-compatible'
import { baseRequest, SENTINEL, withPrepared } from './helpers'

interface Logged {
  method: string | undefined
  url: string | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, 'localhost', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port assigned')
      resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve()
    })
  })
}

describe('redirect exfiltration fixture', () => {
  let target: Server
  let source: Server
  let targetLog: Logged[]
  let sourceLog: Logged[]
  let targetPort: number
  let sourcePort: number

  afterEach(async () => {
    await close(source)
    await close(target)
  })

  it('rejects transient, hits the source once, never reaches the target with credentials or prompt', async () => {
    targetLog = []
    sourceLog = []

    target = createServer((req, res) => {
      void readBody(req).then((body) => {
        targetLog.push({ method: req.method, url: req.url, headers: req.headers, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    targetPort = await listen(target)

    source = createServer((req, res) => {
      void readBody(req).then((body) => {
        sourceLog.push({ method: req.method, url: req.url, headers: req.headers, body })
        res.writeHead(302, {
          location: 'http://localhost:' + String(targetPort) + '/redirected',
        })
        res.end()
      })
    })
    sourcePort = await listen(source)

    const provider = openaiCompatible({
      apiKey: () => 'sk-should-never-leave-source',
      baseUrl: 'http://localhost:' + String(sourcePort),
    })
    const complete = await withPrepared(provider)

    await expect(complete(baseRequest({ prompt: SENTINEL }))).rejects.toSatisfy(
      (error: unknown) => ProviderError.is(error) && error.kind === 'transient',
    )

    expect(sourceLog.length).toBe(1)
    expect(targetLog.length).toBe(0)
    expect(sourceLog[0]!.headers.authorization).toBe('Bearer sk-should-never-leave-source')
    expect(sourceLog[0]!.body).toContain(SENTINEL)
    // The target log is empty by construction, but this states the exfiltration property
    // in its own terms rather than only via the count.
    expect(targetLog.every((entry) => entry.headers.authorization === undefined)).toBe(true)
    expect(targetLog.every((entry) => !entry.body.includes(SENTINEL))).toBe(true)
  })
})
