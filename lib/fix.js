/**
 * The descriptor surgery this plugin performs, as a pure function.
 *
 * `fixModelDescriptor` is the whole fix: pi-ai builds an Anthropic Messages
 * request from the model descriptor a route resolves, and one descriptor switch
 * decides which thinking form that request carries. With
 * `compat.forceAdaptiveThinking === true`, `streamSimple` maps the selected
 * reasoning level onto an Anthropic effort and sends
 * `thinking: { type: "adaptive" }` plus `output_config: { effort }`. Without
 * it, pi-ai sends `thinking: { type: "enabled", budget_tokens }`, which the
 * `die` relay's `claude-sonnet-5-5` answers with HTTP 400.
 *
 * @module dsh-die-adaptive-thinking/fix
 */

import { isTarget, isTargetApi } from './config.js'

/**
 * Return the model descriptor a request should be built from.
 *
 * @param model - the descriptor pi-ai's collection resolved for this pair.
 * @param provider - the route id.
 * @param modelId - the model id.
 * @param options - effective plugin options.
 * @returns the descriptor to use, or the original one when out of scope.
 */
export function fixModelDescriptor(model, provider, modelId, options) {
  if (model === null || typeof model !== 'object') return model
  if (!isTarget(options, provider, modelId)) return model
  if (!isTargetApi(options, model.api)) return model
  if (model.compat?.forceAdaptiveThinking === true) return model
  return { ...model, compat: { ...model.compat, forceAdaptiveThinking: true } }
}
