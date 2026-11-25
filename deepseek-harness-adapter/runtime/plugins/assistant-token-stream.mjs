/**
 * DSH plugin: publish process-local assistant token deltas as ACP updates.
 *
 * Why this exists
 * ---------------
 * `dsh-acp` projects committed assistant messages: one `agent_message_chunk`
 * per assistant text block, delivered after the step commits. That is not
 * token streaming.
 *
 * The agent loop *does* publish every provider token as an
 * `agent/assistant-stream` chunk. This plugin listens to that process-local
 * feed and writes each text/reasoning delta to stdout as a standard ACP
 * `session/update` notification, so an ACP client receives token-granular
 * updates while stdout remains valid newline-delimited JSON-RPC.
 *
 * The adapter loads this file through a `--patch` overlay and sets
 * `DSH_ACP_TOKEN_STREAM=1`. Without that environment variable the plugin is
 * inert, so the patch is safe to leave in a profile.
 *
 * The token chunks carry `_meta: { "dsh-acp/token": true }` and a
 * `token-<attemptId>` messageId. The adapter uses that marker to suppress the
 * later committed block (otherwise text would appear twice) and reconciles the
 * two views when the turn settles.
 */

/** Plugin name shown in the composed loader tree. */
export const name = 'acp-token-stream';

/** Marker copied into each ACP update's `_meta`. */
const TOKEN_META = 'dsh-acp/token';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function enabled(value) {
  return value === '1' || value === 'true';
}

/**
 * @param {string} sessionId
 * @param {any} frame
 * @param {'text' | 'reasoning'} kind
 * @param {string} text
 */
function emitDelta(sessionId, frame, kind, text) {
  const messageId = `token-${String(frame.attemptId)}`;
  const notification = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: kind === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
        messageId,
        content: { type: 'text', text },
        _meta: {
          [TOKEN_META]: true,
          attemptId: frame.attemptId,
          revision: frame.revision,
          index: frame.index,
        },
      },
    },
  };
  try {
    process.stdout.write(`${JSON.stringify(notification)}\n`);
  } catch {
    // The ACP transport is gone; nothing to do.
  }
}

/**
 * Mount the token-forwarding listener.
 *
 * @param {any} ctx cordis context
 */
export function apply(ctx) {
  if (!enabled(process.env.DSH_ACP_TOKEN_STREAM)) {
    return;
  }

  ctx.on(
    'agent/assistant-stream',
    ({ agent, frame }) => {
      if (frame === null || typeof frame !== 'object' || frame.type !== 'chunk') {
        return;
      }
      const chunk = frame.chunk;
      if (chunk === null || typeof chunk !== 'object') {
        return;
      }
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') {
        return;
      }
      if (typeof chunk.text !== 'string' || chunk.text === '') {
        return;
      }
      const sessionId = agent?.session?.id;
      if (typeof sessionId !== 'string' || sessionId === '') {
        return;
      }
      emitDelta(sessionId, frame, chunk.type === 'reasoning-delta' ? 'reasoning' : 'text', chunk.text);
    },
    { global: true },
  );
}
