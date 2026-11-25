/**
 * Automatic recall: inject a small, relevance-ranked slice of cloud memory in
 * front of the user messages that are about to enter a step.
 *
 * Why `agent/pre-step` and not a system-prompt section: the AgentArts search is
 * an async HTTP call, while a system-prompt section provider is synchronous
 * (dsh-memory documents the same constraint). `agent/pre-step` is the waterfall
 * that may replace the messages entering a step, which is exactly the shape
 * needed for query-conditioned recall.
 *
 * Contract notes that matter:
 * - A listener that does not take over must return `next()`, or it swallows
 *   every other plugin's rewrite.
 * - The `enter` decision carries a complete, identified, frozen message batch,
 *   so the injected message is built and frozen here.
 * - Every failure degrades to `next()`: memory recall must never be able to
 *   break a conversation.
 *
 * @module dsh-agentarts-memory/recall
 */

import { randomUUID } from 'node:crypto'

/** Rough characters-per-token ratio used for the injection budget (conservative). */
export const CHARS_PER_TOKEN = 3

/** Marker that makes injected context recognisable in the transcript. */
export const RECALL_MARKER = '[AgentArts memory]'

/**
 * Concatenate the text of the messages entering this step into one query.
 *
 * @param {ReadonlyArray<{content?: unknown}>} messages - pending user messages
 * @returns {string}
 */
export function extractQuery(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    const blocks = message?.content
    if (typeof blocks === 'string') {
      parts.push(blocks)
      continue
    }
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim()
}

/**
 * Render the recall block, dropping low-score hits and respecting a token
 * budget. Returns an empty string when nothing fits.
 *
 * @param {ReadonlyArray<{content: string, score: number, strategyType?: string}>} hits
 * @param {{maxInjectTokens: number, minScore: number}} limits
 * @returns {string}
 */
export function renderRecallBlock(hits, limits) {
  const usable = (Array.isArray(hits) ? hits : [])
    .filter((hit) => typeof hit?.content === 'string' && hit.content !== '')
    .filter((hit) => (typeof hit.score === 'number' ? hit.score : 0) >= limits.minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  if (usable.length === 0) return ''

  const budgetChars = Math.max(120, Math.round(limits.maxInjectTokens * CHARS_PER_TOKEN))
  const header = `${RECALL_MARKER} Possibly relevant long-term memories recalled from Huawei Cloud (score in brackets). Use huawei_memory_search for more, and ignore anything unrelated to the current task.`
  const lines = []
  let used = header.length

  for (const hit of usable) {
    const type = hit.strategyType === undefined || hit.strategyType === '' ? 'memory' : hit.strategyType
    const line = `- [${(hit.score ?? 0).toFixed(2)}] (${type}) ${hit.content}`
    if (used + line.length + 1 > budgetChars) break
    lines.push(line)
    used += line.length + 1
  }

  if (lines.length === 0) return ''
  return [header, ...lines].join('\n')
}

/**
 * Build one frozen, identified user message carrying plugin-injected context.
 *
 * `source.kind` is `user` because that is the only 4-value union this DSH build
 * declares for `MessageSource` (`user` / model / `tool` / `system-prompt`) and
 * the pre-step contract accepts `UserMessage`s only. Provenance is stated in
 * the text instead.
 *
 * @param {string} text - rendered context block
 * @returns {object} frozen UserMessage
 */
export function createRecallMessage(text) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
  Object.freeze(message.content[0])
  Object.freeze(message.content)
  Object.freeze(message.source)
  return Object.freeze(message)
}

/**
 * Register the `agent/pre-step` waterfall.
 *
 * @param {object} ctx - Cordis plugin context
 * @param {import('./gateway.js').MemoryGateway} gateway - cloud gateway
 * @param {object} config - resolved configuration
 * @param {{ok: boolean}} readiness - result of `checkReady` at activation
 */
export function applyRecall(ctx, gateway, config, readiness) {
  /** Per-agent set of already-injected memory texts, so a multi-step turn does not repeat itself. */
  const injected = new WeakMap()
  /** Query → hits cache, shared across agents (the space is shared too). */
  const cache = new Map()

  const cacheKey = (query) => query.toLowerCase()

  /**
   * @param {string} query
   * @returns {Promise<Array<{content: string, score: number, strategyType: string}>>}
   */
  const search = async (query) => {
    const key = cacheKey(query)
    const now = Date.now()
    const cached = cache.get(key)
    if (cached !== undefined && now - cached.at < config.recall.cacheMs) return cached.hits

    const hits = await gateway.search(query, {
      topK: config.recall.topK,
      minScore: config.recall.minScore,
    })
    if (cache.size > 200) cache.clear()
    cache.set(key, { at: now, hits })
    return hits
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    if (!readiness.ok || !config.recall.enabled) return next()

    try {
      const query = extractQuery(payload?.messages)
      if (query.length < config.recall.minQueryChars) return next()

      const hits = await search(query)
      const agent = payload?.agent
      let seen = agent === undefined ? undefined : injected.get(agent)
      if (agent !== undefined && seen === undefined) {
        seen = new Set()
        injected.set(agent, seen)
      }

      const fresh = (hits ?? []).filter((hit) => seen === undefined || !seen.has(hit.content))
      const block = renderRecallBlock(fresh, {
        maxInjectTokens: config.recall.maxInjectTokens,
        minScore: config.recall.minScore,
      })
      if (block === '') return next()

      for (const hit of fresh) seen?.add(hit.content)

      return {
        kind: 'enter',
        messages: [createRecallMessage(block), ...(payload.messages ?? [])],
      }
    } catch {
      // Degrade silently: recall is an optimisation, never a dependency.
      return next()
    }
  })
}
