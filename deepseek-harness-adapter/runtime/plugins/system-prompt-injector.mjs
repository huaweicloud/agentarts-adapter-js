/**
 * DSH plugin: inject the adapter's per-session system prompt with a mode.
 *
 * The adapter writes `<sessionId>.json` (`{ text, mode }`) into
 * `DSH_SYSTEM_PROMPT_DIR` immediately before each turn. This plugin hooks the
 * `system-prompt/assemble` waterfall, so it can:
 *
 * - `append`      add the text after the deployment persona prefix (default);
 * - `replace`     replace the deployment persona prefix text, keeping the DSH
 *                 harness identity, runtime context and tool guidance;
 * - `replace-all` replace every system-prompt section with the text.
 *
 * A waterfall (rather than a section registered at `agent/created`) means the
 * mode and text can change on every turn, including a reused session.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Plugin name shown in the composed loader tree. */
export const name = 'system-prompt-injector';

/** Section name used for the injected text. It is never rendered as a header. */
const SECTION_NAME = 'deployment:agent-system-prompt';
const PERSONA_SECTION = 'deployment:persona-prefix';

/**
 * Keep the file name filesystem-safe even if a harness session id is unusual.
 *
 * @param {string} sessionId
 * @returns {string}
 */
function safeSessionId(sessionId) {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * @param {string} directory
 * @param {string} sessionId
 * @returns {{ text: string, mode: 'append' | 'replace' | 'replace-all' } | null}
 */
function readPrompt(directory, sessionId) {
  const file = path.join(directory, `${safeSessionId(sessionId)}.json`);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Forward compatibility with an older plain-text file.
    return raw.trim() === '' ? null : { text: raw, mode: 'append' };
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.text !== 'string') {
    return null;
  }
  const mode =
    parsed.mode === 'replace' || parsed.mode === 'replace-all' ? parsed.mode : 'append';
  return parsed.text.trim() === '' ? null : { text: parsed.text, mode };
}

/**
 * Mount the prompt waterfall.
 *
 * @param {any} ctx cordis context
 */
export function apply(ctx) {
  const directory = process.env.DSH_SYSTEM_PROMPT_DIR;
  if (typeof directory !== 'string' || directory === '') {
    return;
  }

  ctx.on(
    'system-prompt/assemble',
    async (_assembly, context, next) => {
      // Run as the outermost listener so this sees every other prompt
      // contribution, then apply the per-turn mode to the final sections.
      const assembly = await next();
      const sessionId = context?.agent?.session?.id;
      if (typeof sessionId !== 'string' || sessionId === '') {
        return assembly;
      }
      const prompt = readPrompt(directory, sessionId);
      if (prompt === null) {
        return assembly;
      }

      const custom = {
        name: SECTION_NAME,
        text: prompt.text,
        interpolate: false,
      };
      const sections = [...assembly.sections];
      let result;
      if (prompt.mode === 'replace-all') {
        // Match DSH's complete-prompt semantics: keep only required runtime
        // context entries, drop optional ones along with other prompt sections.
        result = {
          ...assembly,
          sections: [custom],
          contexts: (assembly.contexts ?? []).filter((entry) => entry.required === true),
        };
      } else {
        const personaIndex = sections.findIndex((section) => section.name === PERSONA_SECTION);
        if (prompt.mode === 'replace') {
          if (personaIndex === -1) {
            sections.push(custom);
          } else {
            sections.splice(personaIndex, 1, custom);
          }
        } else {
          // append: keep the deployment persona, then add the per-turn text.
          if (personaIndex === -1) {
            sections.push(custom);
          } else {
            sections.splice(personaIndex + 1, 0, custom);
          }
        }
        result = { ...assembly, sections };
      }
      const debugFile = process.env.DSH_SYSTEM_PROMPT_DEBUG_FILE;
      if (typeof debugFile === 'string' && debugFile !== '') {
        writeFileSync(debugFile, JSON.stringify(result, null, 2));
      }
      return result;
    },
    { prepend: true },
  );
}
