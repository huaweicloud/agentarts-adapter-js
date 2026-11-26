/**
 * Capture: after a session ends, push its conversational turns to the cloud so
 * the platform's own memory strategies extract long-term memories.
 *
 * This is the only path that produces memories without the agent explicitly
 * asking, which is why it is off by default: it sends conversation text to a
 * remote service and it costs a server-side extraction pass.
 *
 * Tool calls and tool results are dropped on purpose — the extraction strategies
 * work on dialogue, and shell output is exactly the kind of content that should
 * not be uploaded.
 *
 * @module dsh-agentarts-memory/capture
 */

/** Cap on one rendered turn, in characters. */
export const TURN_CHAR_LIMIT = 4000

/**
 * Flatten message content blocks into plain text.
 *
 * @param {unknown} blocks - content block array (or a bare string)
 * @returns {string}
 */
export function flattenBlocks(blocks) {
  if (typeof blocks === 'string') return blocks.trim()
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Render the conversational turns of session events, keeping only the newest
 * `maxMessages` of them.
 *
 * @param {ReadonlyArray<{type: string, data?: any}>} events - session events, oldest first
 * @param {number} maxMessages - cap on returned turns
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 */
export function renderTurns(events, maxMessages) {
  if (!Array.isArray(events)) return []
  const turns = []

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      const content = flattenBlocks(event.data?.content)
      if (content !== '') turns.push({ role: 'user', content: content.slice(0, TURN_CHAR_LIMIT) })
      continue
    }
    if (event.type === 'assistant/message') {
      const content = flattenBlocks(event.data?.message?.content)
      if (content !== '') turns.push({ role: 'assistant', content: content.slice(0, TURN_CHAR_LIMIT) })
    }
  }

  const cap = Number.isInteger(maxMessages) && maxMessages > 0 ? maxMessages : 40
  return turns.slice(-cap)
}

/**
 * Register the `session/disposed` capture hook.
 *
 * @param {object} ctx - Cordis plugin context
 * @param {import('./gateway.js').MemoryGateway} gateway - cloud gateway
 * @param {object} config - resolved configuration
 * @param {{ok: boolean}} readiness - result of `checkReady` at activation
 * @param {{warn: Function}} log - logger from `createLogger`
 */
export function applyCapture(ctx, gateway, config, readiness, log) {
  ctx.on('session/disposed', (session) => {
    if (!readiness.ok || !config.capture.enabled) return

    void (async () => {
      try {
        const start = Number.isInteger(session?.firstLiveSeq) ? session.firstLiveSeq : 0
        const events = Array.isArray(session?.events) ? session.events.slice(start) : []
        const turns = renderTurns(events, config.capture.maxMessages)
        if (turns.length === 0) return

        const pushed = await gateway.pushMessages(String(session.id), turns)
        log.info(`captured ${pushed} message(s) from session ${String(session.id)}`)
      } catch (error) {
        log.warn(`capture failed for session ${String(session?.id)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  })
}
