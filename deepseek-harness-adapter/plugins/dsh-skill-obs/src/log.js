/**
 * A tiny logger that prefers the host's logger and stays quiet otherwise.
 *
 * @module dsh-skill-obs/log
 */

/**
 * @param {object} ctx - Cordis plugin context
 * @param {string} name - logger name / prefix
 * @returns {{info: Function, warn: Function}}
 */
export function createLogger(ctx, name) {
  const host = ctx !== null && typeof ctx === 'object' ? ctx.logger : undefined
  const prefix = `[${name}]`

  const call = (level, message) => {
    if (host !== undefined && typeof host[level] === 'function') {
      host[level](message)
      return
    }
    if (level !== 'info') {
      console.warn(`${prefix} ${message}`)
    }
  }

  return {
    info: (message) => call('info', String(message)),
    warn: (message) => call('warn', String(message)),
  }
}
