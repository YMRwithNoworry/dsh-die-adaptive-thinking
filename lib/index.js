/**
 * `dsh-die-adaptive-thinking` — lets dsh use `die`'s `claude-sonnet-5-5`.
 *
 * ## The failure this exists for
 *
 * The `die` relay (`https://cfapi.dieqiyun.top`, Anthropic Messages) serves
 * `claude-sonnet-5-5`, and that model no longer accepts budget-based extended
 * thinking. dsh selects the reasoning level, pi-ai turns it into
 * `thinking: { type: "enabled", budget_tokens: … }`, and the relay answers:
 *
 * ```text
 * 400 claude-sonnet-5-5 requires adaptive thinking or thinking.type=between_tools;
 *     omit thinking or use one of those modes
 * ```
 *
 * Because the turn dies on its first request, nothing can be salvaged
 * downstream: the session retries the same rejected request.
 *
 * ## What it does
 *
 * The plugin never rewrites a request and never touches the session log. It
 * decorates the adapter `@deepseek-ai/dsh-llm-pi-ai` registers, so the
 * descriptor a request is built from already carries the switch this upstream
 * needs:
 *
 * - `compat.forceAdaptiveThinking = true` makes `streamSimple` send
 *   `thinking: { type: "adaptive", display: "summarized" }` plus
 *   `output_config: { effort }` instead of the budget form. The relay accepts
 *   that with every effort level, and pi-ai's own catalog uses the same switch
 *   for models that require adaptive thinking.
 *
 * Only the configured route/model pairs and only Anthropic Messages models are
 * touched, so the older Claude models behind the same relay keep working.
 *
 * ## Placement
 *
 * The adapter is reached by decorating `LlmRuntime.registerAdapter`, which is
 * only possible when this plugin mounts before the pi-ai route is registered:
 * list its bundle ahead of `@deepseek-ai/dsh-base` in `dsh.profile.bundles`.
 * A late mount is covered by a second path that swaps the already-registered
 * adapter in place; the plugin logs which path it took.
 *
 * @module dsh-die-adaptive-thinking
 */

import { isTarget, normalizeConfig } from './config.js'
import { fixModelDescriptor } from './fix.js'

export {
  DEFAULT_APIS,
  DEFAULT_DEFAULTS,
  DEFAULT_MODELS,
  DEFAULT_ROUTES,
  isTarget,
  isTargetApi,
  normalizeConfig,
} from './config.js'
export { fixModelDescriptor } from './fix.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'die-adaptive-thinking'

/** The LLM seam must exist before an adapter can be decorated. */
export const inject = ['llm']

/**
 * Apply the fix.
 *
 * @param ctx - the plugin context (`llm` is injected).
 * @param config - the composition entry's config.
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  if (!options.enabled) return

  const install = () => installFix(ctx.llm, options, ctx.logger)
  if (typeof ctx.effect === 'function') ctx.effect(() => install())
  else install()
}

/**
 * Decorate one `LlmRuntime`-shaped service and return its disposer.
 *
 * Exported for tests and for compositions that hold the service themselves.
 * Patching the method's owner — the prototype when the service is a class
 * instance — is deliberate: adapters register through the service the profile
 * handed to `@deepseek-ai/dsh-llm-pi-ai`, which is not necessarily the exact
 * object this plugin was given.
 *
 * @param llm - the `llm` service.
 * @param options - effective plugin options.
 * @param logger - optional cordis logger.
 * @returns a disposer that restores every patched method and adapter.
 */
export function installFix(llm, options, logger) {
  if (llm === null || typeof llm !== 'object') return () => {}

  const registerOwner = ownerOf(llm, 'registerAdapter')
  const originalRegister = registerOwner?.registerAdapter

  const state = { active: true }
  const wrappers = new WeakMap()

  const patchedRegister =
    typeof originalRegister === 'function'
      ? function (providers, adapter) {
          const routes = Array.isArray(providers) ? providers : []
          if (!routes.some((route) => options.routes.includes(route))) {
            return originalRegister.call(this, providers, adapter)
          }
          const wrapped = wrapAdapter(adapter, options, wrappers, logger, state)
          return originalRegister.call(this, providers, wrapped)
        }
      : undefined

  const restores = []
  if (patchedRegister) restores.push(installMethod(llm, registerOwner, 'registerAdapter', patchedRegister))

  // A mount after the route registration cannot see `registerAdapter` again, so
  // the registration record that already exists is decorated in place instead.
  const lateRoutes = decorateRegistered(llm, options, wrappers, logger, state)
  restores.push(...lateRoutes.restores)

  if (options.log) {
    if (lateRoutes.routes.length > 0) {
      logger?.info?.(
        `${name}: decorated already-registered route(s) ${lateRoutes.routes.join(', ')} in place; requests to ${describeTargets(options)} now use adaptive thinking`,
      )
    } else if (patchedRegister) {
      logger?.info?.(
        `${name}: will decorate route(s) ${options.routes.join(', ')} when the adapter registers; requests to ${describeTargets(options)} will use adaptive thinking`,
      )
    } else {
      logger?.warn?.(
        `${name}: the llm service exposes no registerAdapter, so this build cannot be decorated; nothing was changed`,
      )
    }
  }

  return () => {
    // An adapter registered while this plugin was mounted keeps its wrapper, so
    // the wrapper has to go inert rather than be unregistered.
    state.active = false
    for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]()
  }
}

/**
 * Decorate every already-registered route in scope, by swapping the adapter on
 * the registration record the runtime's `adapters` map holds.
 *
 * @param llm - the `llm` service.
 * @param options - effective plugin options.
 * @param wrappers - per-adapter cache.
 * @param logger - optional cordis logger.
 * @param state - shared installation state.
 * @returns the routes decorated, and the disposers restoring them.
 */
function decorateRegistered(llm, options, wrappers, logger, state) {
  const routes = []
  const restores = []
  const registrations = llm.adapters
  if (!(registrations instanceof Map)) return { routes, restores }

  for (const [route, registration] of registrations) {
    if (!options.routes.includes(route)) continue
    if (registration === null || typeof registration !== 'object') continue
    const original = registration.adapter
    if (original === null || typeof original !== 'object') continue
    const wrapped = wrapAdapter(original, options, wrappers, logger, state)
    if (wrapped === original) continue
    try {
      registration.adapter = wrapped
    } catch {
      logger?.warn?.(`${name}: route "${route}" holds a read-only registration; nothing was changed for it`)
      continue
    }
    routes.push(route)
    restores.push(() => {
      if (registration.adapter === wrapped) registration.adapter = original
    })
  }

  return { routes, restores }
}

/**
 * Build the adapter wrapper: the raw adapter, with only `modelOf` replaced.
 *
 * `Object.create` rather than a `Proxy`, because the wrapper must behave like
 * the adapter for everything else — `instanceof`, its own `config`/snapshot
 * fields, and every other method — while `this` inside those methods stays the
 * wrapper, so their internal `this.modelOf(...)` reaches the fixed lookup.
 *
 * @param adapter - the adapter the pi-ai plugin registered.
 * @param options - effective plugin options.
 * @param wrappers - per-adapter cache, so a re-registration reuses one wrapper.
 * @param logger - optional cordis logger.
 * @param state - shared installation state.
 * @returns the wrapper, or the adapter unchanged when it is not shaped as expected.
 */
function wrapAdapter(adapter, options, wrappers, logger, state) {
  if (adapter === null || typeof adapter !== 'object') return adapter
  const cached = wrappers.get(adapter)
  if (cached !== undefined) return cached
  if (typeof adapter.modelOf !== 'function') {
    if (options.log) {
      logger?.warn?.(
        `${name}: the registered adapter exposes no modelOf, so this pi-ai build cannot be decorated; nothing was changed`,
      )
    }
    return adapter
  }

  const wrapper = Object.create(adapter)
  wrapper.modelOf = function (snapshot, provider, model) {
    const base = adapter.modelOf(snapshot, provider, model)
    return state.active ? fixModelDescriptor(base, provider, model, options) : base
  }

  wrappers.set(adapter, wrapper)
  return wrapper
}

/**
 * Put one patched method in place on both the service and the prototype that
 * owns it, so the patch is reached whether the profile hands a call site the
 * service instance itself or a proxy over it.
 *
 * @param service - the service object handed to this plugin.
 * @param owner - the object owning the original method, when one was found.
 * @param method - method name.
 * @param patched - the replacement.
 * @returns a disposer restoring every write this made.
 */
function installMethod(service, owner, method, patched) {
  const restores = []
  if (owner !== undefined && owner !== service) {
    const original = owner[method]
    if (original !== patched) {
      owner[method] = patched
      restores.push(() => {
        if (owner[method] === patched) owner[method] = original
      })
    }
  }
  try {
    const hadOwn = Object.prototype.hasOwnProperty.call(service, method)
    const original = hadOwn ? service[method] : undefined
    Object.defineProperty(service, method, { value: patched, configurable: true, writable: true })
    restores.push(() => {
      if (service[method] !== patched) return
      if (hadOwn) Object.defineProperty(service, method, { value: original, configurable: true, writable: true })
      else delete service[method]
    })
  } catch {
    // A frozen service keeps whatever the prototype patch installed.
  }
  return () => {
    for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]()
  }
}

/** The object owning a method, so a patch survives a per-access service proxy. */
function ownerOf(service, method) {
  if (typeof service[method] === 'function') {
    const proto = Object.getPrototypeOf(service)
    if (proto !== null && typeof proto[method] === 'function') return proto
    return service
  }
  return undefined
}

/** Human-readable scope, for one log line. */
function describeTargets(options) {
  const models = options.models.length === 0 ? 'all models' : options.models.join(', ')
  return `${models} on ${options.routes.join(', ')}`
}
