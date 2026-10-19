/**
 * End-to-end wire check: the request pi-ai actually puts on the socket.
 *
 * The unit tests assert the descriptor switch. This test asserts the thing the
 * relay rejected: with the switch, the body carries `thinking.type: "adaptive"`
 * and an effort instead of the `thinking.type: "enabled"` budget form.
 *
 * It needs a copy of `@earendil-works/pi-ai`, which ships inside dsh rather than
 * with this plugin. The test locates one from the usual installs and skips when
 * none is present, so the suite stays green on a machine without dsh.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { normalizeConfig } from '../lib/config.js'
import { fixModelDescriptor } from '../lib/fix.js'

const ENTRY = 'dist/api/anthropic-messages.js'

/** Candidate pi-ai installs, most specific first. */
function candidates() {
  const list = []
  if (process.env.PI_AI_PACKAGE_PATH) {
    const given = process.env.PI_AI_PACKAGE_PATH
    list.push(given.endsWith('.js') ? given : path.join(given, ENTRY))
  }
  const npmRoot = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : undefined
  if (npmRoot) list.push(path.join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', ENTRY))
  for (const profile of ['web', 'desktop', 'dsh-tui']) {
    list.push(path.join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@earendil-works', 'pi-ai', ENTRY))
  }
  let directory = process.cwd()
  for (;;) {
    list.push(path.join(directory, 'node_modules', '@earendil-works', 'pi-ai', ENTRY))
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return list
}

async function loadPiAi() {
  for (const candidate of candidates()) {
    if (!existsSync(candidate)) continue
    try {
      return await import(pathToFileURL(candidate).href)
    } catch {
      // Try the next candidate; an unreadable install is not a test failure.
    }
  }
  return null
}

/** A minimal Anthropic streaming response, enough for pi-ai to finish a turn. */
const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

/** A model descriptor as dsh-llm-pi-ai materializes the die route's models. */
function descriptor(baseUrl, compat, modelId = 'claude-sonnet-5-5') {
  return {
    id: modelId,
    name: modelId,
    api: 'anthropic-messages',
    provider: 'die',
    baseUrl,
    input: ['text'],
    contextWindow: 1000000,
    maxTokens: 256000,
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat,
  }
}

const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }

/**
 * Run one request through pi-ai against a local capture server.
 *
 * @param streamSimple - pi-ai's simple Anthropic implementation.
 * @param model - the descriptor to build the request from.
 * @returns the parsed request body the adapter sent.
 */
async function capture(streamSimple, model) {
  const bodies = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      bodies.push({ url: request.url, body: JSON.parse(body) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(SSE)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const live = { ...model, baseUrl: `http://127.0.0.1:${port}` }

  try {
    const stream = streamSimple(live, context, { apiKey: 'test-key', reasoning: 'high', maxTokens: 2048 })
    for await (const event of stream) {
      if (event.type === 'error') throw new Error(`stream failed: ${event.error?.errorMessage ?? event.reason}`)
    }
  } finally {
    server.close()
  }

  assert.equal(bodies.length, 1, 'one request reached the wire')
  return bodies[0].body
}

const options = normalizeConfig()

test('the unpatched descriptor reproduces the rejected budget form', async (t) => {
  const piAi = await loadPiAi()
  if (piAi === null) return t.skip('pi-ai is not installed on this machine')

  const body = await capture(piAi.streamSimple, descriptor('http://placeholder', {}))
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 16384, display: 'summarized' })
  assert.equal(body.output_config, undefined)
})

test('the fixed descriptor sends adaptive thinking with the selected effort', async (t) => {
  const piAi = await loadPiAi()
  if (piAi === null) return t.skip('pi-ai is not installed on this machine')

  const raw = descriptor('http://placeholder', {})
  const fixed = fixModelDescriptor(raw, 'die', 'claude-sonnet-5-5', options)
  const body = await capture(piAi.streamSimple, fixed)

  assert.equal(body.thinking.type, 'adaptive')
  assert.equal(body.thinking.display, 'summarized')
  assert.equal(body.thinking.budget_tokens, undefined, 'no budget is sent in adaptive mode')
  assert.deepEqual(body.output_config, { effort: 'high' })
})

test('claude-opus-5-5 is fixed the same way', async (t) => {
  const piAi = await loadPiAi()
  if (piAi === null) return t.skip('pi-ai is not installed on this machine')

  const raw = descriptor('http://placeholder', {}, 'claude-opus-5-5')
  const fixed = fixModelDescriptor(raw, 'die', 'claude-opus-5-5', options)
  const body = await capture(piAi.streamSimple, fixed)

  assert.equal(body.thinking.type, 'adaptive')
  assert.equal(body.thinking.budget_tokens, undefined)
  assert.deepEqual(body.output_config, { effort: 'high' })
})

test('every effort level maps onto the adaptive form', async (t) => {
  const piAi = await loadPiAi()
  if (piAi === null) return t.skip('pi-ai is not installed on this machine')

  const fixed = fixModelDescriptor(descriptor('http://placeholder', {}), 'die', 'claude-sonnet-5-5', options)
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const body = await captureEffort(piAi.streamSimple, fixed, effort)
    assert.equal(body.thinking.type, 'adaptive', `effort ${effort}`)
    assert.equal(body.output_config.effort, effort, `effort ${effort} maps through pi-ai's Anthropic effort table`)
  }
})

/** Like {@link capture}, but with the requested reasoning level parameterized. */
async function captureEffort(streamSimple, model, effort) {
  const bodies = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      bodies.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(SSE)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const live = { ...model, baseUrl: `http://127.0.0.1:${port}` }

  try {
    const stream = streamSimple(live, context, { apiKey: 'test-key', reasoning: effort, maxTokens: 2048 })
    for await (const event of stream) {
      if (event.type === 'error') throw new Error(`stream failed: ${event.error?.errorMessage ?? event.reason}`)
    }
  } finally {
    server.close()
  }
  return bodies[0]
}
