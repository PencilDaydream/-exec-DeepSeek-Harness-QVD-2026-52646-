# 代码与注释摘录（逐字抽取自 deepseek-harness @ c291e7961a）

> 生成方式：直接 sed 抽取，未改写任何字符；注释为源码原文（英文）。
> 每节标题给出 file:line，便于回源码核对。

---

## 1. exec 里为什么有 agent：ToolExecutionInput.agent

`packages/core/tools/src/index.ts:302-331`

```ts
/**
 * Caller-supplied description of one tool call. {@link ToolRuntime.execute}
 * adds the registry-owned token to form a pipeline {@link ToolExecution};
 * callers do not choose that token.
 */
export interface ToolExecutionInput {
  readonly callId: ToolCallId
  /**
   * Root model-requested call owning this execution tree. Callers omit it for
   * a root execution; nested dispatchers propagate the enclosing value.
   */
  readonly rootCallId?: ToolCallId
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: Agent
  /**
   * Opaque token of the enclosing transport execution, when one exists. PTC
   * mode sets this on SDK sub-dispatches so commit-style observers can wait for
   * the outer `run_code` outcome without receiving its live mutable execution.
   * The token also marks the call as a transport sub-dispatch rather than a
   * model-direct call: under `mode: 'ptc'`, only calls WITH a parent may
   * execute a native tool name — a model-direct call (no parent) is denied as
   * `UNKNOWN_TOOL` before the policy pipeline. See {@link ToolRuntime.execute}.
   */
  readonly parent?: ToolExecutionToken
  /** Required caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
}
```

---

## 2. ToolExecution / ToolRunContext 完整字段

`packages/core/tools/src/index.ts:365-417`

```ts
/**
 * One pending tool call inside the registry pipeline. Parsed arguments cross
 * one lossless-JSON materialization boundary before policy and are deep-frozen;
 * call identity, the caller signal, and the registry-assigned {@link token} are
 * readonly. The registry freezes the complete object before `tools/result`
 * observers run.
 */
export interface ToolExecution extends ToolExecutionInput {
  /** Root model-requested call, resolved for every root and nested execution. */
  readonly rootCallId: ToolCallId
  /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: ToolExecutionToken
}

/**
 * Around-dispatch view of a {@link ToolExecution}. A `tools/execute` wrapper
 * may replace the signal for its delegated lifetime, but it cannot remove it.
 * The registry fuses every replacement with the captured caller signal.
 */
export interface ToolDispatchExecution extends Omit<ToolExecution, 'signal'> {
  /** Cancellation signal visible to the next wrapper or tool body. */
  signal: AbortSignal
}

/**
 * Runtime context handed to a tool implementation after the registry has
 * accepted a {@link ToolExecution}. {@link deferContext} attaches context to
 * this execution's own result — a composite tool ferries nested-dispatch
 * context back to the outer result, and a leaf tool may mint a fresh
 * plugin-sourced instruction; the loop appends it only after the
 * `tool/result`.
 */
export interface ToolRunContext extends ToolExecution {
  /**
   * Defer one context — typically a nested-dispatch context ferried by a
   * composite tool, or a fresh plugin-sourced instruction — until this tool's
   * final result reaches the agent loop. Contexts retain their individual
   * source and metadata and are emitted in call order.
   */
  deferContext(context: UserMessage): void
  /**
   * Mark a successful final result as terminal for the current agent turn.
   * The marker rides this execution's own result (`concludesTurn` exists only
   * on {@link ToolExecutionSuccess}); a composite that dispatches nested
   * calls forwards it from the nested result, exactly like
   * `additionalContexts`, so only an authoritative nested success can
   * conclude the enclosing run.
   */
  concludeTurn(): void
}

/** Registry-owned live execution object; public pipeline views stay readonly. */
type MutableToolRunContext = Omit<ToolRunContext, 'signal'> & { signal: AbortSignal }
```

---

## 3. 注册表组装 exec（agent 原样进入 base）

`packages/core/tools/src/index.ts:1354-1400`

```ts
  private createExecution(exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext } {
    const deferredContexts: UserMessage[] = []
    const token = createExecutionToken()
    const callId = exec.callId
    const rootCallId = exec.rootCallId ?? callId
    const name = exec.name
    const agent = exec.agent
    const parent = exec.parent
    const signal = exec.signal
    // Distinguish a mode-collapsed call (visible in the scope, denied only by
    // the `ptc` collapse) from a genuinely unknown tool. A collapsed call is
    // deterministically denied, so it terminates BEFORE the extensible policy
    // pipeline: pre-execute listeners, approval `ask`, and guards must never
    // observe — or worse, approve — a call that can only fail. An unknown tool
    // keeps the historical dispatch-stage `UNKNOWN_TOOL` path so policy
    // listeners still see every name that reaches the registry.
    const visible = this.get(name, agent)
    const collapsed = visible !== undefined && this.collapses(name, agent, parent !== undefined)
    const concludingExecutions = this.concludingExecutions
    const base = {
      token,
      callId,
      rootCallId,
      name,
      signal,
      ...agent !== undefined ? { agent } : {},
      ...parent !== undefined ? { parent } : {},
      deferContext(context: UserMessage): void {
        deferredContexts.push(context)
      },
      concludeTurn(): void {
        concludingExecutions.add(this as unknown as ToolExecution)
      },
    }
    // Capture the finalizer BEFORE argument materialization: the
    // `finalizeContent` contract snapshots the callback when the call starts,
    // and an arguments getter can replace or clear the registered callback
    // during `snapshotJsonValue`. The collapse only decides whether the
    // CAPTURED callback is retained: the pre-dispatch abort path keeps it
    // (the cancellation contract routes aborted results through it — a getter
    // that aborts mid-materialization before an invalid-args failure lands in
    // the same retained path), while the `UNKNOWN_TOOL` denial and the
    // invalid-args failure of a NON-ABORTED collapsed call drop it (the call
    // could never execute).
    const capturedFinalizer = visible?.finalizeContent?.bind(visible)
    const finalizerFor = (): ToolDefinition['finalizeContent'] | undefined =>
      collapsed && !signal.aborted ? undefined : capturedFinalizer
```

---

## 4. 真实派发点：agent loop 注入发起 agent

`packages/core/agent-loop/src/tool-calls.ts:62-80`

```ts
  turn: number,
  step: number,
  toolCalls: ToolCallBlock[],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<{ concluded: boolean }> {
  const agent = ctx.agents.requireInitiator()
  const { session } = agent

  // Inputs are distinct because tools/execute wrappers may replace `exec.signal`.
  const planned: PlannedCall[] = toolCalls.map(block => ({
    block,
    exec: {
      callId: block.id,
      name: block.name,
      arguments: parseArguments(block.arguments),
      agent,
      signal,
    },
```

---

## 5. 公开 Agent 契约：只有 id

`packages/core/agent/src/types.ts:12-18`

```ts
/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}

declare module '@deepseek-ai/dsh-typert-protocol' {
```

---

## 6. 运行时面增补：ctx / session / inbox / status / options

`packages/core/agent/src/runtime-types.ts:160-180`

```ts
      | { readonly kind: 'abandoned' }
  }

declare module './types.ts' {
  interface Agent {
    /** The provider route and model this agent's requests use. */
    readonly options: AgentOptions
    /** The live session this agent drives; its log is the durable source of truth. */
    readonly session: Session
    /** Agent-owned access to durable pending work. */
    readonly inbox: Inbox
    /** The current lifecycle state, mirrored on every `agent/status` transition. */
    readonly status: AgentStatus
    /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
    readonly ctx: Context

    /**
   * Clear queued and steering work — unless `keepInbox` — and abort the active
   * turn or between-turn task. The first cause wins for that activity. With no
   * active activity, cancellation is a no-op and does not arm later work.
   * @param cause - the stable caller intent carried by the active operation signal.
```

---

## 7. 运行时面增补的方法（cancel/whenIdle/send/steer/inject…）

`packages/core/agent/src/runtime-types.ts:181-245`

```ts
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
    cancel(cause: AgentCancelCause, options?: CancelOptions): void

    /**
   * Resolve after the current whole-agent activity reaches quiescence. This
   * follows replacement work started before the observed driver retires,
   * but does not identify the settlement of any particular message.
   * @returns fulfillment after no active driver or maintenance task remains.
   */
    whenIdle(): Promise<void>

    /**
   * Run one non-turn maintenance task from the true idle phase. The task starts
   * synchronously after claiming that phase; later waking input remains in the
   * inbox until the task settles, while public status stays `idle`.
   * `whenIdle()` follows both the task and any waking work released behind it.
   * @param task - operation whose fulfillment or rejection is preserved, with a signal aborted by {@link cancel}.
   * @throws synchronously when turn-driving or another maintenance task already owns the agent.
   * @returns the task promise.
   */
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>

    /**
   * Route identified input to an inbox boundary and optionally wake the driver.
   * Waking input submitted after active cancellation is queued for the next
   * turn and runs when the aborted activity converges to idle; a `disposed`
   * cancel leaves it parked. A wake submitted while already idle always opens
   * its turn boundary, even when its message is cleared before the driver
   * claims ([cancel-convergence wake latch](../../../../.agents/notes/implemented/bug-fix/2026-08-07-cancel-convergence-wake-latch.md)).
   * @param message - identified content and the source that supplied it.
   * @param target - the preferred next-turn or next-step inbox boundary.
   * @param wakeup - whether delivery may wake the driver.
   */
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void

    /**
   * Queue an ordinary follow-up turn and wake the driver. The item becomes the
   * sole ordinary message of its own turn.
   * @param message - identified prompt content and the source that supplied it.
   */
    followup(message: UserMessage): void

    /**
   * Submit steering for the nearest step. An idle driver starts a turn;
   * a running driver consumes it at its next step boundary.
   * A rejected step leaves steering parked in the inbox until the next
   * wake; cancellation or disposal may discard pending steering.
   * @param message - identified steering content and the source that supplied it.
   */
    steer(message: UserMessage): void

    /**
   * Queue model-facing context for the next pre-step without waking the
   * driver. A running driver claims it at the nearest later step boundary;
   * idle drivers leave it pending until follow-up or steering
   * wakes them. It may miss a request whose pre-step already claimed its
   * batch. Cancellation or disposal may discard pending context.
   * @param message - identified injected context and the source that supplied it.
   */
    inject(message: UserMessage): void
  }
}

declare module '@deepseek-ai/cordis' {
```

---

## 8. 动态工具注册处：exec 原样透传给 vm 域函数

`packages/extensions/cordis-host-runner/src/guard.ts:558-592`

```ts
  if (typeof output.render !== 'function') throw new Error('harness.defineTool output.render must be a function')
  if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
    throw new Error('harness.defineTool output.presentationMeta must be a function when present')
  }
  if (typeof options.execute !== 'function') throw new Error('harness.defineTool execute must be a function')
  const schema = cloneJson(output.schema, 'harness.defineTool output.schema')
  const rawExecute = options.execute as (args: unknown, exec: unknown) => Promise<unknown>
  const rawRender = output.render as (args: unknown, value: unknown) => unknown
  const rawPresentationMeta = output.presentationMeta as ((args: unknown, value: unknown) => unknown) | undefined
  const erasedDefineTool = defineTool as unknown as (definition: unknown) => ToolDefinition
  const tool = erasedDefineTool({
    ...options,
    parameters: normalized.spec,
    output: {
      schema,
      render(args: unknown, value: unknown): ContentBlock[] {
        return assertRenderedContent(cloneJson(rawRender(args, value), 'harness.defineTool output.render result') as JsonValue)
      },
      ...rawPresentationMeta !== undefined ? {
        presentationMeta(args: unknown, value: unknown): JsonValue {
          return cloneJson(rawPresentationMeta(args, value), 'harness.defineTool output.presentationMeta result') as JsonValue
        },
      } : {},
    },
    async execute(args: unknown, exec: unknown): Promise<JsonValue> {
      return cloneJson(await rawExecute(args, exec), 'harness.defineTool execute result') as JsonValue
    },
  })
  const parameters = { ...tool.parameters, ...normalized.rootAnnotations }
  assertSupportedJsonSchema(parameters)
  return markDynamicTool({
    ...tool,
    parameters,
  })
}
```

---

## 9. apply 的 façade：白名单动词 + 拒绝 Context 返回值

`packages/extensions/cordis-host-runner/src/guard.ts:630-700`

```ts

/**
 * The verbs a running host half may reach through the sandbox `ctx` façade, beyond its injected
 * services. `on`/`once` observe events, `provide` exposes a service to other packages, and the
 * timer helpers schedule work — each a fiber effect that unwinds when the package stops.
 */
const CTX_VERBS = new Set(['effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])
const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

/**
 * The tool-registry façade: `register` (marker-guarded) plus READ-ONLY
 * metadata (`schemas`, and `get` returning a schema view, never the live
 * `ToolDefinition`). Exposing the raw definition would hand package code the
 * tool's `execute` function, letting it call another tool directly and bypass
 * `ToolRuntime.execute` — identity protection, pre-policy, monotonic guards,
 * around dispatch, post-policy, final observation, and result normalization. So `get` returns the same
 * name/description/parameters view as `schemas()`, and nothing invocable.
 */
function sandboxTools(ctx: Context): Record<string, unknown> {
  // Resolve reads and writes through the package's own scope.
  return {
    register: (tool: unknown): (() => void) => sandboxRegisterTool(ctx, tool),
    schemas: () => ctx.tools.schemas(scopeOf(ctx)),
    get: (name: string) => ctx.tools.schemas(scopeOf(ctx)).find(schema => schema.name === name),
  }
}

/**
 * Reject any injected-service return that is a cordis `Context`. Harness
 * services return data, never a context; a value that is one would be a
 * fresh, unguarded handle back into the runtime — the exact escape the façade
 * exists to close — so it fails loud instead of reaching sandbox code.
 */
// Twinned with the browser half's guard for the same reason as the ctx façade
// below: this is the rule "a service must never hand sandboxed code a Context",
// and each half must test against the Context class of ITS OWN face. Moving the
// rule into a shared package would move a security invariant out of the halves
// that enforce it, which is a design decision rather than a duplication fix.
/* jscpd:ignore-start */
function denyContext(value: unknown, service: string, reportFailure: (error: Error) => void): unknown {
  if (value instanceof Context) {
    return rejectGuard(reportFailure,
      `service "${service}" returned a cordis Context, which the sandbox does not expose. `
      + 'Operate through your own plugin ctx (ctx.on / ctx.provide / ctx.tools.register) '
      + 'and the services you inject — never another context.',
    )
  }
  return value
}

/**
 * Wrap an injected service so its methods forward to the real instance but
 * their return values pass through {@link denyContext}. Non-function members
 * (plain data) pass through as-is; a returned Promise is guarded on resolve.
 */
function guardedService(service: object, name: string, reportFailure: (error: Error) => void): unknown {
  return new Proxy(service, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return denyContext(value, name, reportFailure)
      return (...args: unknown[]): unknown => {
        const result = Reflect.apply(value, target, args) as unknown
        if (result instanceof Promise) return result.then(v => denyContext(v, name, reportFailure))
        return denyContext(result, name, reportFailure)
      }
    },
  })
}
/* jscpd:ignore-end */

/**
```

---

## 10. sandboxContext：拒绝框架内部 + readService 门

`packages/extensions/cordis-host-runner/src/guard.ts:712-800`

```ts

/**
 * Whitelist context for running host halves: lifecycle-safe verbs, guarded
 * tools, optional `ctx.get()` lookup, and declared-service property access.
 * Framework plumbing is denied, and service methods cannot return a Context.
 */
function sandboxContext(ctx: Context, reportFailure: (error: Error) => void): Context {
  const tools = sandboxTools(ctx)
  const declared = declaredInjects(ctx)
  // A framework member or an undeclared service — distinguish the two so the
  // error teaches the right fix (declare it in inject vs it is withheld).
  const denyRead = (prop: string): never => {
    if (ctx.get(prop) !== undefined) {
      return rejectGuard(reportFailure,
        `service "${prop}" is not injected. Declare it: inject: ['${prop}', …] on your plugin, `
        + 'so cordis parks this dynamic package if the provider later goes away.',
      )
    }
    return rejectGuard(reportFailure,
      `sandbox ctx does not expose "${prop}". Available: ctx.tools.register / ctx.on / ctx.provide / `
      + 'the timer helpers after injecting timer, and any service you declared in inject. '
      + 'Framework internals (root, fiber, registry, extend, plugin, …) are withheld by design.',
    )
  }
  // `get` is optional lookup; property access requires a declaration. `tools`
  // is the façade's own API on either path.
  const readService = (name: string, requireDeclaration: boolean): unknown => {
    if (name === 'tools') return tools
    if (requireDeclaration && !declared.has(name)) return denyRead(name)
    const service = denyContext(ctx.get(name), name, reportFailure)
    if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return service
    return guardedService(service, name, reportFailure)
  }
  const get = (name: string): unknown => readService(name, false)
  // The browser half builds the same façade over its own Context
  // (`@deepseek-ai/dsh-cordis-client-runner`, whose CTX_VERBS names this one its
  // twin), and the sameness is the point: a package author meets ONE contract on
  // both halves. Folding them together is not available — the two halves compile
  // in separate programs where `Context` merges different service keys — so the
  // duplication is declared here instead of hidden behind a config exception.
  /* jscpd:ignore-start */
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'tools') return tools
      if (prop === 'get') return get
      if (typeof prop !== 'string') return undefined
      // Lazy verb forwarder — reads `ctx[verb]` only when called. Timer mixins
      // additionally require the Service declaration before Cordis resolves them.
      if (CTX_VERBS.has(prop)) {
        return (...args: unknown[]): unknown => {
          if (TIMER_VERBS.has(prop) && !declared.has('timer')) return denyRead('timer')
          const method = ctx[prop as keyof Context]
          return Reflect.apply(method as (...a: unknown[]) => unknown, ctx, args)
        }
      }
      return readService(prop, true)
    },
    // A façade is not the real ctx; block writes rather than let package code
    // stash state on a throwaway object and think it persisted.
    set(_target, prop) {
      return rejectGuard(reportFailure, `sandbox ctx is read-only; cannot assign "${String(prop)}"`)
    },
    // `in` reflects reachability: the façade API plus DECLARED services
    // (whether or not currently live). Does not resolve/wrap — no throw.
    has: (_target, prop) => prop === 'tools' || prop === 'get'
      || (typeof prop === 'string'
        && ((CTX_VERBS.has(prop) && (!TIMER_VERBS.has(prop) || declared.has('timer'))) || declared.has(prop))),
  }) as unknown as Context
  /* jscpd:ignore-end */
}

/**
 * Narrow an arbitrary sandbox return value to a runnable cordis plugin: a
 * function, or an object with an `apply` function. (A bare function passes the
 * first arm, so the object arm never sees `Function.prototype.apply`.)
 * @param value - whatever the host half returned.
 * @returns whether the value can be started via `ctx.plugin`.
 */
export function isPlugin(value: unknown): value is Plugin {
  if (typeof value === 'function') return true
  return typeof value === 'object' && value !== null
    && typeof (value as { apply?: unknown }).apply === 'function'
}

/**
 * Wrap a plugin so `apply` receives the sandbox context while preserving injection metadata.
 * @param plugin - the plugin the host half returned.
 * @param reportFailure - reports a guard rejection to the owning Agent.
 * @returns an equivalent plugin whose `apply` sees the sandbox context façade.
```

---

## 11. 浏览器半边孪生 façade

`packages/extensions/cordis-client-runner/src/client/guard.ts:1-30`

```ts
/**
 * The browser twin of the tool-cordis context facade: a whitelist of
 * lifecycle-safe verbs plus optional `ctx.get()` lookup and declared-service
 * property access, with
 * framework internals withheld and Context-valued returns denied. Two seats
 * carry extra machinery: `slots`, where the register proxy assigns the
 * shadowing priority and ledgers the registration — invoking the service with
 * the traced receiver so the effect lands on the CALLING plugin's fiber
 * (SlotRegistry.register must stay a prototype method for exactly that
 * reason) — and `theme`, whose override source is pinned to the package id.
 *
 * This is API discipline, not a security boundary: a dynamic package's code is
 * as trusted as the host process that accepted its definition.
 */

import { Context } from '@deepseek-ai/cordis'
import type { DynamicCordisPackage } from '@deepseek-ai/dsh-api-remotes/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Facade verbs beyond declared services (host CTX_VERBS twin). */
const CTX_VERBS = new Set([
  'effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce',
])
const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

/** One package's slot-registration ledger row (contribution projection source). */
export interface DynamicCordisSlotLedgerRow {
  /** Target slot name. */
  slot: string
```

---

## 12. runner README 的信任立场（Trust stance）

`packages/extensions/cordis-host-runner/README.md:50-56`

```ts
Definitions are session-scoped and process-local: a package is visible only to the session that defined it, other sessions read it as absent, and everything disappears on DSH restart. The session log keeps the define call's arguments — including the code it submitted — and the receipt; only the in-memory registry holds the parsed definition. A browser half reaches a page only through a run, so a reloaded page holds nothing until someone runs the package again.

### Trust stance

The sandbox isolates globals but is not a security boundary: Node globals are absent or redirect to Cordis services (`ctx.fs`, `ctx.web`, `ctx.bash`, the timer helpers), and a host half receives a façade without framework internals, yet the services it declares reach the live runtime. Treat a dynamic package like bash access — see the [self-referential toolset Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md).

-----
```

---

## 13. vm 沙箱注入的全局与陷阱

`packages/extensions/cordis-host-runner/src/sandbox.ts:96-145`

```ts
const NODE_API_REDIRECTS: Record<string, string> = {
  require:
    'Node modules are unavailable. Use the cordis services on ctx instead — e.g. inject: [\'fs\'] for files, '
    + '[\'web\'] for HTTP, [\'bash\'] for processes; query Service.listService with cordis_inspect_query first.',
  setTimeout: TIMER_REDIRECT,
  setInterval: TIMER_REDIRECT,
  setImmediate: TIMER_REDIRECT,
  clearTimeout: TIMER_REDIRECT,
  clearInterval: TIMER_REDIRECT,
  fetch:
    'Network access goes through the cordis web service: declare inject: [\'web\'] and call ctx.web '
    + '(query Host Service.listService with cordis_inspect_query for its methods).',
}

/** Build the trap functions for {@link NODE_API_REDIRECTS}: calling one throws the redirect. */
function nodeApiTraps(): Record<string, () => never> {
  const traps: Record<string, () => never> = {}
  for (const [name, redirect] of Object.entries(NODE_API_REDIRECTS)) {
    traps[name] = () => {
      throw new Error(`${name} is not available in the dynamic package sandbox — ${redirect}`)
    }
  }
  return traps
}

/**
 * Build the vm context one host half evaluates in: the tagged console, the
 * `harness` registration helpers, the encoding primitives, the Node-API traps,
 * and the dual-realm `instanceof` patch, already `createContext`-ed.
 * @param id - the package id (`dyn-<n>`), used as the console tag and filename stem.
 * @param harnessExtras - per-package `harness` verbs beyond the registration pair (`handle`).
 * @returns the contextified sandbox object to pass to {@link evaluateHostCode}.
 */
export function createSandbox(id: string, harnessExtras: Record<string, unknown> = {}): object {
  const sandbox = {
    ...nodeApiTraps(),
    console: taggedConsole(id),
    harness: { defineTool: sandboxDefineTool, registerTool: sandboxRegisterTool, ...harnessExtras },
    // Web APIs absent from fresh vm contexts — made available so the model
    // can encode/decode base64 without Buffer (which is also absent). Host
    // closures over Buffer, never Buffer itself.
    btoa: (s: string) => Buffer.from(s, 'utf-8').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('utf-8'),
    TextEncoder,
    TextDecoder,
  }
  createContext(sandbox)
  patchDualRealmInstanceof(sandbox)
  return sandbox
}
```

---

## 14. 模型可见类型目录：Agent 只声明 id

`packages/extensions/tool-cordis/src/api-catalog.ts:3575-3581`

```ts
    declaration: 'export type AdmittedPromptContentPart = {\n    readonly type: \'text\';\n    readonly text: string;\n} | {\n    readonly type: \'image\';\n    readonly attachment: ImageAttachmentRef;\n} | {\n    readonly type: \'file\';\n    readonly attachment: FileAttachmentRef;\n};',
  },
  {
    name: 'Agent',
    declaration: 'export interface Agent {\n    readonly id: SessionId;\n}',
  },
  {
```

---

## 15. 模型可见类型目录：ToolRunContext 声明

`packages/extensions/tool-cordis/src/api-catalog.ts:6119-6126`

```ts
    declaration: 'export type ToolResultView = GenericResultView | TerminalResultView | DiffResultView | SearchResultView | ReadResultView | WebResultView;',
  },
  {
    name: 'ToolRunContext',
    declaration: 'export interface ToolRunContext extends ToolExecution {\n    deferContext(context: UserMessage): void;\n    concludeTurn(): void;\n}',
  },
  {
    name: 'ToolRuntime',
```

---

## 16. subprocess 缝的自述（无沙箱约束）

`packages/subprocess/subprocess-local/src/index.ts:1-12`

```ts
/**
 * Local Service Provider for the subprocess capability seam. Each spawn owns a
 * platform-selected managed range with the spec's per-stream stdio dispositions.
 * Normal disposal terminates and joins live ranges; Node's synchronous exit
 * phase force-stops any ranges the service still owns. It has no config: every
 * disposition and limit arrives on the spec, so deployment-varying choices
 * stay with the caller's config (the bash executor's, the LSP host's, …).
 * @module @deepseek-ai/dsh-subprocess-local
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
```

---

## 17. bwrap profile（新版新增 --unshare-pid）

`packages/sandbox/sandbox-local/src/profiles.ts:10-24`

```ts

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

```
