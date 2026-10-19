import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_APIS,
  DEFAULT_DEFAULTS,
  DEFAULT_MODELS,
  DEFAULT_ROUTES,
  isTarget,
  isTargetApi,
  normalizeConfig,
} from '../lib/config.js'

test('defaults target the die relay and the two adaptive-only models', () => {
  const options = normalizeConfig()
  assert.deepEqual(options.routes, DEFAULT_ROUTES)
  assert.deepEqual(options.models, DEFAULT_MODELS)
  assert.deepEqual(options.apis, DEFAULT_APIS)
  assert.equal(options.enabled, true)
  assert.equal(options.log, true)
  assert.deepEqual(DEFAULT_DEFAULTS.models, ['claude-sonnet-5-5', 'claude-opus-5-5'])
})

test('a missing or empty config still resolves every default', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_DEFAULTS)
  assert.deepEqual(normalizeConfig({}), DEFAULT_DEFAULTS)
})

test('an empty models list widens the fix to the whole route', () => {
  const options = normalizeConfig({ models: [] })
  assert.deepEqual(options.models, [])
  assert.equal(isTarget(options, 'die', 'claude-opus-5'), true)
  assert.equal(isTarget(options, 'die', 'claude-sonnet-5-5'), true)
})

test('an empty routes list falls back to the documented route', () => {
  const options = normalizeConfig({ routes: [] })
  assert.deepEqual(options.routes, DEFAULT_ROUTES)
})

test('explicit values replace the defaults', () => {
  const options = normalizeConfig({
    routes: ['die', 'proxy'],
    models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
    apis: ['anthropic-messages'],
    log: false,
  })
  assert.deepEqual(options.routes, ['die', 'proxy'])
  assert.deepEqual(options.models, ['claude-sonnet-5-5', 'claude-opus-5-5'])
  assert.equal(options.log, false)
})

test('unknown keys are dropped, not rejected', () => {
  const options = normalizeConfig({ somethingNew: 42, enabled: false })
  assert.equal(options.enabled, false)
  assert.equal('somethingNew' in options, false)
})

test('model matching is exact so a sibling model is not widened in', () => {
  const options = normalizeConfig()
  assert.equal(isTarget(options, 'die', 'claude-sonnet-5-5'), true)
  assert.equal(isTarget(options, 'die', 'claude-opus-5-5'), true)
  assert.equal(isTarget(options, 'die', 'claude-sonnet-5'), false)
  assert.equal(isTarget(options, 'die', 'claude-opus-5'), false)
  assert.equal(isTarget(options, 'die', 'claude-sonnet-5-5-preview'), false)
  assert.equal(isTarget(options, 'a11', 'claude-sonnet-5-5'), false)
  assert.equal(isTarget(options, undefined, 'claude-sonnet-5-5'), false)
})

test('only configured wire protocols are in scope', () => {
  const options = normalizeConfig()
  assert.equal(isTargetApi(options, 'anthropic-messages'), true)
  assert.equal(isTargetApi(options, 'openai-completions'), false)
  assert.equal(isTargetApi(options, undefined), false)
})
