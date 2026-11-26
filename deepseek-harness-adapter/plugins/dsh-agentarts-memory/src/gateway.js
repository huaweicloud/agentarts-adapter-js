/**
 * The AgentArts Memory data-plane client.
 *
 * This is a self-contained replacement for `@huaweicloud/agentarts-sdk`'s
 * `MemoryClient`, restricted to the calls this plugin makes. It exists because
 * the SDK cannot be a dependency here: its `package.json` declares
 * `"@huaweicloud/huaweicloud-sdk-agentidentity": "workspace:*"` and pnpm
 * refuses to install a `file:` dependency carrying a workspace protocol, so a
 * plugin installed from this directory would have nothing to resolve. With the
 * client inlined the plugin runs with no build step and no extra setup beyond
 * `AGENTARTS_MEMORY_SPACE_ID` and `HUAWEICLOUD_SDK_MEMORY_API_KEY` in the
 * environment.
 *
 * The wire format is transcribed from the SDK sources, not guessed:
 *
 * | call | request |
 * | --- | --- |
 * | search | `POST /v1/core/spaces/{space_id}/memories/search` |
 * | save | `POST /v1/core/spaces/{space_id}/memories` |
 * | remove | `DELETE /v1/core/spaces/{space_id}/memories/{memory_id}` |
 * | session | `POST /v1/core/spaces/{space_id}/sessions` |
 * | messages | `POST /v1/core/spaces/{space_id}/sessions/{session_id}/messages` |
 *
 * Auth is `Authorization: Bearer <api key>`; the data plane does no request
 * signing. Failures become {@link GatewayError} so callers can degrade instead
 * of throwing into the agent loop.
 *
 * @module dsh-agentarts-memory/gateway
 */

/** Failure of one gateway call. `code` is stable and safe to branch on. */
export class GatewayError extends Error {
  /**
   * @param {string} code - `unconfigured` | `timeout` | `aborted` | `http` | `network`
   * @param {string} message - human readable detail
   */
  constructor(code, message) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
  }
}

/**
 * @typedef {object} MemoryHit
 * @property {string} id - cloud memory record id, empty when absent
 * @property {string} content - the memory text
 * @property {number} score - similarity score, 0 when absent
 * @property {string} strategyType - builtin strategy name, empty when absent
 */

/**
 * Resolve the data-plane base URL. An explicit `endpoint` wins over the
 * environment, which wins over the region default.
 *
 * @param {{endpoint?: string, region: string}} config - resolved configuration
 * @param {Record<string, string|undefined>} [env] - environment source
 * @returns {string} base URL without a trailing slash
 */
export function resolveBaseUrl(config, env = process.env) {
  const raw =
    (typeof config.endpoint === 'string' ? config.endpoint.trim() : '') ||
    (typeof env.AGENTARTS_MEMORY_DATA_ENDPOINT === 'string' ? env.AGENTARTS_MEMORY_DATA_ENDPOINT.trim() : '') ||
    `memory.${config.region}.huaweicloud-agentarts.com`

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * Build the search request body. Field names and the always-present
 * `only_actived` / `rerank` pair mirror the SDK's `MemorySearchFilter`.
 *
 * @param {{query: string, topK?: number, minScore?: number, strategyType?: string, actorId?: string, assistantId?: string, rerank?: boolean}} options
 * @returns {Record<string, unknown>}
 */
export function buildSearchBody(options) {
  /** @type {Record<string, unknown>} */
  const body = { query: options.query }
  if (options.strategyType !== undefined && options.strategyType !== '') body.strategy_type = options.strategyType
  if (options.actorId !== undefined && options.actorId !== '') body.actor_id = options.actorId
  if (options.assistantId !== undefined && options.assistantId !== '') body.assistant_id = options.assistantId
  if (options.topK !== undefined) body.top_k = options.topK
  if (options.minScore !== undefined) body.min_score = options.minScore
  body.only_actived = false
  // Operator-controlled via AGENTARTS_MEMORY_RERANK; the backend default is on.
  body.rerank = options.rerank === undefined ? true : options.rerank
  return body
}

/**
 * Pull our fields out of one search result, tolerating both wire shapes the
 * backend has been seen to use (`{record, score}` and a flat record).
 *
 * @param {unknown} raw - one entry of the search response
 * @returns {MemoryHit}
 */
export function normalizeHit(raw) {
  const holder = raw !== null && typeof raw === 'object' ? raw : {}
  const record = holder.record !== null && typeof holder.record === 'object' ? holder.record : holder
  const score = typeof holder.score === 'number' && Number.isFinite(holder.score) ? holder.score : 0

  const content =
    typeof record.content === 'string'
      ? record.content
      : typeof record.text === 'string'
        ? record.text
        : typeof holder.content === 'string'
          ? holder.content
          : ''

  return {
    id: typeof record.id === 'string' ? record.id : '',
    content: content.replace(/\s+/g, ' ').trim(),
    score,
    strategyType:
      typeof record.strategy_type === 'string'
        ? record.strategy_type
        : typeof record.strategyType === 'string'
          ? record.strategyType
          : '',
  }
}

/**
 * Normalise a search response envelope (`{records:[{record,score}]}` or
 * `{results:[…]}`) into hits, dropping entries with no text.
 *
 * @param {unknown} payload - parsed response body
 * @returns {MemoryHit[]}
 */
export function normalizeSearchResponse(payload) {
  const data = payload !== null && typeof payload === 'object' ? payload : {}
  let entries = []
  if (Array.isArray(data.records)) {
    entries = data.records.map((record) =>
      record !== null && typeof record === 'object' ? { record: record.record, score: record.score } : record,
    )
  } else if (Array.isArray(data.results)) {
    entries = data.results
  }
  return entries.map(normalizeHit).filter((hit) => hit.content !== '')
}

/** The memory gateway. One instance per plugin activation. */
export class MemoryGateway {
  #config
  #env

  /**
   * @param {object} config - resolved configuration (see `resolveConfig`)
   * @param {Record<string, string|undefined>} [env] - environment source
   */
  constructor(config, env = process.env) {
    this.#config = config
    this.#env = env
  }

  /** The API key, read late so a shell change is picked up without a restart. */
  get apiKey() {
    return this.#env[this.#config.apiKeyEnv] ?? ''
  }

  /** Data-plane base URL for this gateway. */
  get baseUrl() {
    return resolveBaseUrl(this.#config, this.#env)
  }

  /**
   * One HTTP call, with the deadline and the caller's cancellation both wired
   * into `fetch` so an abandoned request is really aborted.
   *
   * @param {string} method - HTTP method
   * @param {string} path - path beginning with `/`
   * @param {{body?: unknown, signal?: AbortSignal, label: string, timeoutMs?: number}} options
   * @returns {Promise<any>} parsed JSON body, `{}` for 204, or `{response}` for non-JSON
   */
  async request(method, path, options) {
    if (this.apiKey === '') {
      throw new GatewayError('unconfigured', `environment variable ${this.#config.apiKeyEnv} is empty`)
    }

    const url = `${this.baseUrl}${path}`
    const timeoutMs = options.timeoutMs ?? this.#config.timeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

    let response
    try {
      response = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new GatewayError('timeout', `${options.label} exceeded ${timeoutMs}ms`)
      }
      if (error?.name === 'AbortError') {
        throw new GatewayError('aborted', `${options.label} aborted`)
      }
      throw new GatewayError('network', `${options.label} failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (response.status === 204) return {}

    if (!response.ok) {
      let code = 'UNKNOWN_ERROR'
      let message = `HTTP ${response.status}`
      try {
        const payload = await response.json()
        if (typeof payload?.error_code === 'string') code = payload.error_code
        if (typeof payload?.error_msg === 'string') message = payload.error_msg
      } catch {
        // A non-JSON error body keeps the HTTP status message.
      }
      throw new GatewayError('http', `${options.label} failed: [${code}] ${message}`)
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.startsWith('application/json')) {
      try {
        return await response.json()
      } catch (error) {
        throw new GatewayError('network', `${options.label} returned unparseable JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { response: await response.text() }
  }

  /** The space path prefix every call uses. */
  #spacePath() {
    const spaceId = String(this.#config.spaceId ?? '').trim()
    if (spaceId === '') throw new GatewayError('unconfigured', 'space id is not set (AGENTARTS_MEMORY_SPACE_ID)')
    return `/v1/core/spaces/${encodeURIComponent(spaceId)}`
  }

  /**
   * Semantic search over the space.
   *
   * @param {string} query - natural language query
   * @param {{topK?: number, minScore?: number, strategyType?: string, signal?: AbortSignal, timeoutMs?: number}} [options]
   * @returns {Promise<MemoryHit[]>}
   */
  async search(query, options = {}) {
    const body = buildSearchBody({
      query,
      topK: options.topK ?? this.#config.recall.topK,
      minScore: options.minScore ?? this.#config.recall.minScore,
      strategyType: options.strategyType,
      actorId: this.#config.actorId,
      assistantId: this.#config.assistantId,
      rerank: this.#config.rerank,
    })
    const payload = await this.request('POST', `${this.#spacePath()}/memories/search`, {
      body,
      signal: options.signal,
      label: 'memory search',
      // Recall must not hold a turn hostage; writes keep the longer default.
      timeoutMs: options.timeoutMs ?? this.#config.recall.timeoutMs,
    })
    return normalizeSearchResponse(payload)
  }

  /**
   * Push conversation messages so the platform extracts long-term memories.
   *
   * @param {string} sessionId - DSH session id, reused as the cloud session id
   * @param {Array<{role: string, content: string}>} messages - plain text turns
   * @param {string} [idempotencyKey] - per-push dedupe key. Must change on every capture so
   *   the cloud accepts repeated appends to the same session; reusing the session id would
   *   make each subsequent append look like a retry of the first and be rejected.
   * @returns {Promise<number>} number of messages accepted
   */
  async pushMessages(sessionId, messages, idempotencyKey) {
    const id = String(sessionId ?? '').trim()
    if (id === '') throw new GatewayError('http', 'session id must not be empty')
    if (!Array.isArray(messages) || messages.length === 0) return 0
    const key =
      typeof idempotencyKey === 'string' && idempotencyKey.trim() !== '' ? idempotencyKey.trim() : id

    const space = this.#spacePath()

    /** @type {Record<string, unknown>} */
    const sessionBody = { id }
    if (this.#config.actorId !== '') sessionBody.actor_id = this.#config.actorId
    if (this.#config.assistantId !== '') sessionBody.assistant_id = this.#config.assistantId

    try {
      await this.request('POST', `${space}/sessions`, { body: sessionBody, label: 'memory session create' })
    } catch (error) {
      // A session that already exists is the normal case after the first
      // capture; only a genuine failure is worth reporting.
      const message = error instanceof Error ? error.message : String(error)
      if (error?.code !== 'http' || !/exist|conflict|duplicate|409/i.test(message)) throw error
    }

    const batch = await this.request('POST', `${space}/sessions/${encodeURIComponent(id)}/messages`, {
      body: {
        // `parts`, not `content`: the SDK's TextMessage.toDict shape.
        messages: messages.map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          parts: [{ type: 'text', text: message.content }],
        })),
        is_force_extract: true,
        idempotency_key: key,
      },
      label: 'memory message push',
    })

    return Array.isArray(batch?.messages) ? batch.messages.length : messages.length
  }
}
