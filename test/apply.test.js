import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, installFix } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'

/** A descriptor shaped like the one dsh-llm-pi-ai materializes for a custom route. */
function model(overrides = {}) {
  return {
    id: 'claude-sonnet-5-5',
    name: 'claude-sonnet-5-5',
    api: 'anthropic-messages',
    provider: 'die',
    baseUrl: 'https://cfapi.dieqiyun.top',
    input: ['text'],
    contextWindow: 1000000,
    maxTokens: 256000,
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    compat: {},
    ...overrides,
  }
}

/** The pi-ai adapter surface this plugin decorates. */
class FakeAdapter {
  constructor() {
    this.calls = []
  }

  modelOf(_snapshot, provider, modelId) {
    this.calls.push([provider, modelId])
    return model({ provider, id: modelId })
  }

  stream() {
    return (async function* () {})()
  }
}

/** The `LlmRuntime` surface the plugin patches, reduced to what it reads. */
class FakeLlmRuntime {
  constructor() {
    this.adapters = new Map()
    this.registrations = []
  }

  registerAdapter(providers, adapter) {
    for (const provider of providers) {
      this.adapters.set(provider, { adapter, provider: { id: provider, name: provider }, retryPolicy: {} })
    }
    const registration = { providers, adapter }
    this.registrations.push(registration)
    return { replace() {} }
  }

  listProviders() {
    return [...this.adapters.values()].map(({ provider }) => ({ ...provider }))
  }

  stream() {
    return (async function* () {})()
  }
}

/**
 * A fresh runtime class per test.
 *
 * The plugin patches the prototype that owns `registerAdapter`, which is the
 * right thing for a service handed out through a proxy — and wrong for a test
 * suite that shares one prototype between cases. A subclass per case keeps each
 * test's patch on its own prototype.
 */
function freshRuntime() {
  return class extends FakeLlmRuntime {}
}

/** A context that records what the plugin registers, without a real profile. */
function fakeContext(LlmClass = freshRuntime()) {
  const effects = []
  const logs = []
  const logger = {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
  }
  return {
    effects,
    logs,
    logger,
    llm: new LlmClass(),
    on: () => {},
    effect: (callback) => effects.push(callback()),
  }
}

test('apply installs the decoration as an effect', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  assert.equal(ctx.effects.length, 1, 'registerAdapter decoration is installed')
})

test('a disabled row mounts nothing', () => {
  const ctx = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(ctx.effects.length, 0)
})

test('a route registered after the mount is decorated at registration', () => {
  const ctx = fakeContext()
  apply(ctx, {})

  const adapter = new FakeAdapter()
  ctx.llm.registerAdapter(['die'], adapter)

  const registration = ctx.llm.adapters.get('die')
  assert.notEqual(registration.adapter, adapter, 'the runtime holds the wrapper')
  assert.equal(registration.adapter.stream, adapter.stream, 'other methods are inherited')
  const fixed = registration.adapter.modelOf({}, 'die', 'claude-sonnet-5-5')
  assert.equal(fixed.compat.forceAdaptiveThinking, true)
  assert.deepEqual(adapter.calls, [['die', 'claude-sonnet-5-5']], 'the raw adapter still resolves the descriptor')
})

test('a route registered before the mount is decorated in place', () => {
  const ctx = fakeContext()
  const adapter = new FakeAdapter()
  ctx.llm.registerAdapter(['die'], adapter)

  apply(ctx, {})

  const registration = ctx.llm.adapters.get('die')
  assert.notEqual(registration.adapter, adapter)
  assert.equal(registration.adapter.modelOf({}, 'die', 'claude-sonnet-5-5').compat.forceAdaptiveThinking, true)
  assert.equal(ctx.logs.some(([level, message]) => level === 'info' && message.includes('already-registered')), true)
})

test('a multi-route adapter is wrapped once and filtered per route', () => {
  const ctx = fakeContext()
  apply(ctx, {})

  const adapter = new FakeAdapter()
  ctx.llm.registerAdapter(['die', 'a11'], adapter)

  const dieWrapper = ctx.llm.adapters.get('die').adapter
  const a11Wrapper = ctx.llm.adapters.get('a11').adapter
  assert.equal(dieWrapper, a11Wrapper, 'one adapter object serves both routes, so one wrapper covers both')

  assert.equal(dieWrapper.modelOf({}, 'a11', 'claude-sonnet-5-5').compat.forceAdaptiveThinking, undefined)
  assert.equal(dieWrapper.modelOf({}, 'die', 'claude-sonnet-5').compat.forceAdaptiveThinking, undefined)
  assert.equal(dieWrapper.modelOf({}, 'die', 'claude-sonnet-5-5').compat.forceAdaptiveThinking, true)
})

test('claude-opus-5-5 is decorated too', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const adapter = new FakeAdapter()
  ctx.llm.registerAdapter(['die'], adapter)
  const wrapper = ctx.llm.adapters.get('die').adapter
  assert.equal(wrapper.modelOf({}, 'die', 'claude-opus-5-5').compat.forceAdaptiveThinking, true)
  assert.equal(wrapper.modelOf({}, 'die', 'claude-opus-5').compat.forceAdaptiveThinking, undefined)
})

test('a model on another protocol is not fixed even when its id matches', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const adapter = new FakeAdapter()
  ctx.llm.registerAdapter(['die'], adapter)
  const wrapper = ctx.llm.adapters.get('die').adapter

  const raw = model({ api: 'openai-completions' })
  adapter.modelOf = () => raw
  assert.equal(wrapper.modelOf({}, 'die', 'claude-sonnet-5-5'), raw)
})

test('dispose restores the runtime and the in-place decoration', () => {
  const LlmClass = freshRuntime()
  const llm = new LlmClass()
  const adapter = new FakeAdapter()
  llm.registerAdapter(['die'], adapter)
  const methodBefore = LlmClass.prototype.registerAdapter

  const dispose = installFix(llm, normalizeConfig(), undefined)
  assert.notEqual(llm.adapters.get('die').adapter, adapter)
  dispose()

  assert.equal(llm.adapters.get('die').adapter, adapter, 'the original adapter is back')
  assert.equal(LlmClass.prototype.registerAdapter, methodBefore, 'the prototype patch is reverted')
})

test('an adapter without modelOf is reported and left alone', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const adapter = { stream() {} }
  ctx.llm.registerAdapter(['die'], adapter)
  assert.equal(ctx.llm.adapters.get('die').adapter, adapter)
  assert.equal(ctx.logs.some(([level, message]) => level === 'warn' && message.includes('no modelOf')), true)
})

test('a runtime without an adapters map still installs the registration patch', () => {
  const ctx = fakeContext()
  delete ctx.llm.adapters
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(ctx.effects.length, 1)
})

test('a null service is tolerated', () => {
  assert.equal(typeof installFix(null, normalizeConfig(), undefined), 'function')
})
