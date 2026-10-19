/**
 * Configuration for `dsh-die-adaptive-thinking`.
 *
 * Every field has a working default, so the row in `cordis.patch.yml` may carry
 * an empty (or missing) `config` object and the plugin still does the right
 * thing for the route it was written for.
 *
 * @module dsh-die-adaptive-thinking/config
 */

/**
 * Routes the fix applies to unless the profile names others.
 *
 * `die` is the route id this plugin was written for: an Anthropic
 * Messages-compatible relay (`https://cfapi.dieqiyun.top`) whose
 * `claude-sonnet-5-5` rejects budget-based thinking.
 */
export const DEFAULT_ROUTES = ['die']

/**
 * Models the fix applies to unless the profile names others.
 *
 * `claude-sonnet-5-5` is the model that answers
 * `400 claude-sonnet-5-5 requires adaptive thinking or thinking.type=between_tools;
 * omit thinking or use one of those modes` when pi-ai sends
 * `thinking: { type: "enabled", budget_tokens: … }`. Older Claude models on the
 * same relay still take the budget form, so the list is deliberately narrow.
 * An empty list widens the fix to every model the route serves.
 */
export const DEFAULT_MODELS = ['claude-sonnet-5-5']

/**
 * Wire protocols the fix applies to.
 *
 * Only an Anthropic Messages model understands `thinking.type: adaptive`.
 * The switch is a no-op on every other protocol, but the guard keeps a
 * multi-protocol route honest if a profile ever lists models of both shapes.
 */
export const DEFAULT_APIS = ['anthropic-messages']

/**
 * Normalize one profile row's config into the options the plugin runs with.
 *
 * Unknown keys are dropped rather than rejected: a profile that keeps this row
 * in sync with a newer release must not fail to boot because of a field this
 * build does not know yet.
 *
 * @param config - the composition entry's config, as parsed by schemastery.
 * @returns the effective options.
 */
export function normalizeConfig(config = {}) {
  return {
    // Master switch. false keeps the row mounted and logs nothing.
    enabled: config?.enabled !== false,
    routes: stringList(config?.routes, DEFAULT_ROUTES),
    // Empty means "every model on those routes".
    models: stringList(config?.models, DEFAULT_MODELS, { allowEmpty: true }),
    apis: stringList(config?.apis, DEFAULT_APIS),
    log: config?.log !== false,
  }
}

/**
 * Whether one route/model pair is in scope.
 *
 * An empty {@link NormalizedConfig.models} list means every model the route
 * serves; a named model is matched exactly, because model ids on these relays
 * are opaque vendor strings and prefix matching would silently widen the blast
 * radius.
 *
 * @param options - effective options.
 * @param provider - the route id a request names.
 * @param model - the model id a request names, when the caller knows it.
 * @returns true when the plugin owns that pair.
 */
export function isTarget(options, provider, model) {
  if (typeof provider !== 'string' || !options.routes.includes(provider)) return false
  if (options.models.length === 0) return true
  return typeof model === 'string' && options.models.includes(model)
}

/**
 * Whether one wire protocol is in scope.
 *
 * @param options - effective options.
 * @param api - the model descriptor's wire protocol.
 * @returns true when the fix may be applied to a model speaking that protocol.
 */
export function isTargetApi(options, api) {
  return typeof api === 'string' && options.apis.includes(api)
}

function stringList(value, fallback, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) return fallback
  const kept = value.filter((entry) => typeof entry === 'string' && entry.length > 0)
  if (kept.length === 0) return allowEmpty ? [] : fallback
  return kept
}

/** Every default in one place, for documentation and for tests. */
export const DEFAULT_DEFAULTS = {
  enabled: true,
  routes: DEFAULT_ROUTES,
  models: DEFAULT_MODELS,
  apis: DEFAULT_APIS,
  log: true,
}
