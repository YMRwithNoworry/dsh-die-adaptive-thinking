import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { fixModelDescriptor } from '../lib/fix.js'

const options = normalizeConfig()

/** A descriptor shaped like the one dsh-llm-pi-ai materializes for a custom route. */
function model(overrides = {}) {
  return {
    id: 'claude-sonnet-5-5',
    name: 'claude-sonnet-5-5',
    api: 'anthropic-messages',
    provider: 'die',
    baseUrl: 'https://cfapi.dieqiyun.top',
    input: ['text', 'image'],
    contextWindow: 1000000,
    maxTokens: 256000,
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    cost: { input: 0, output: 0 },
    compat: { supportsLongCacheRetention: true },
    ...overrides,
  }
}

test('the target model gains forceAdaptiveThinking', () => {
  const fixed = fixModelDescriptor(model(), 'die', 'claude-sonnet-5-5', options)
  assert.equal(fixed.compat.forceAdaptiveThinking, true)
  assert.equal(fixed.compat.supportsLongCacheRetention, true, 'other compat switches survive')
  assert.equal(fixed.reasoning, true, 'reasoning capability is untouched')
})

test('the input descriptor is not mutated', () => {
  const original = model()
  fixModelDescriptor(original, 'die', 'claude-sonnet-5-5', options)
  assert.equal(original.compat.forceAdaptiveThinking, undefined)
})

test('a model outside the configured route or model list is untouched', () => {
  const foreignRoute = model()
  const foreignModel = model()
  assert.equal(fixModelDescriptor(foreignRoute, 'a11', 'claude-sonnet-5-5', options), foreignRoute)
  assert.equal(fixModelDescriptor(foreignModel, 'die', 'claude-sonnet-5', options), foreignModel)
})

test('a model on another wire protocol is untouched', () => {
  const completions = model({ api: 'openai-completions' })
  assert.equal(fixModelDescriptor(completions, 'die', 'claude-sonnet-5-5', options), completions)
})

test('a descriptor that already carries the switch is returned as is', () => {
  const already = model({ compat: { forceAdaptiveThinking: true } })
  assert.equal(fixModelDescriptor(already, 'die', 'claude-sonnet-5-5', options), already)
})

test('a model without a compat block still gains one', () => {
  const bare = model({ compat: undefined })
  const fixed = fixModelDescriptor(bare, 'die', 'claude-sonnet-5-5', options)
  assert.deepEqual(fixed.compat, { forceAdaptiveThinking: true })
})

test('non-object descriptors pass through', () => {
  assert.equal(fixModelDescriptor(undefined, 'die', 'claude-sonnet-5-5', options), undefined)
  assert.equal(fixModelDescriptor(null, 'die', 'claude-sonnet-5-5', options), null)
})

test('an empty models list fixes every anthropic model on the route', () => {
  const wide = normalizeConfig({ models: [] })
  const opus = model({ id: 'claude-opus-5-5' })
  assert.equal(fixModelDescriptor(opus, 'die', 'claude-opus-5-5', wide).compat.forceAdaptiveThinking, true)
  assert.equal(fixModelDescriptor(model(), 'die', 'claude-sonnet-5-5', wide).compat.forceAdaptiveThinking, true)
})
