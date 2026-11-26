#!/usr/bin/env node
/**
 * MCP stdio ⇄ legacy SSE bridge.
 *
 * `dsh-acp` only mounts stdio or Streamable HTTP MCP servers. AgentArts gateway
 * targets are often legacy HTTP+SSE MCP servers (`server_type: "sse"`), so this
 * process exposes the upstream SSE server as a local stdio MCP server:
 *
 *   node mcp-sse-bridge.mjs <sse-url>
 *   env MCP_BRIDGE_HEADERS='{"x-api-key":"..."}'
 *
 * It is a transparent JSON-RPC relay:
 * - GET the SSE endpoint, wait for the `endpoint` event (POST target);
 * - forward every SSE `message` to stdout (one JSON frame per line);
 * - POST every stdin line to the upstream message endpoint;
 * - log diagnostics to stderr only, never stdout.
 */

import { createInterface } from 'node:readline';

const sseUrl = process.argv[2];
const headers = parseHeaders(process.env.MCP_BRIDGE_HEADERS);
const abortController = new AbortController();
const pending = [];
let postUrl = null;
let chain = Promise.resolve();
let closed = false;
let endpointReady = false;

/**
 * @param {string | undefined} value
 * @returns {Record<string, string>}
 */
function parseHeaders(value) {
  if (value === undefined || value === '') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, header]) => [key, String(header)]));
  } catch {
    return {};
  }
}

/**
 * @param {string} message
 */
function log(message) {
  try {
    process.stderr.write(`[mcp-sse-bridge] ${message}\n`);
  } catch {
    // Ignore.
  }
}

/**
 * @param {string} message
 * @param {number} [code]
 */
function fail(message, code = 1) {
  log(message);
  process.exit(code);
}

if (typeof sseUrl !== 'string' || sseUrl === '') {
  fail('missing SSE URL argument', 2);
}
try {
  new URL(sseUrl);
} catch {
  fail(`invalid SSE URL: ${sseUrl}`, 2);
}

/**
 * POST one JSON-RPC frame to the upstream message endpoint.
 *
 * @param {string} line
 * @returns {Promise<void>}
 */
async function postFrame(line) {
  if (closed) {
    return;
  }
  if (postUrl === null) {
    pending.push(line);
    return;
  }
  try {
    const response = await fetch(postUrl, {
      method: 'POST',
      redirect: Object.keys(headers).length ? 'error' : 'follow',
      headers: {
        ...headers,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: line,
      signal: abortController.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      log(`POST ${response.status}: ${text.slice(0, 300)}`);
      return;
    }
    // Drain without buffering a long-lived body.
    await response.arrayBuffer().catch(() => undefined);
  } catch (error) {
    if (!closed) {
      log(`POST failed: ${error?.message ?? error}`);
    }
  }
}

/** Flush frames that arrived before the SSE endpoint event. */
function flushPending() {
  for (const line of pending.splice(0)) {
    chain = chain.then(() => postFrame(line));
  }
}

/**
 * @param {string} event
 * @param {string} data
 */
function dispatch(event, data) {
  if (data === '') {
    return;
  }
  if (event === 'endpoint') {
    try {
      const target = new URL(data, sseUrl);
      if (target.origin !== new URL(sseUrl).origin && Object.keys(headers).length > 0) {
        fail('credentialed SSE endpoint changed origin');
        return;
      }
      postUrl = target.href;
      endpointReady = true;
      log(`upstream endpoint ready: ${new URL(postUrl).origin}${new URL(postUrl).pathname}`);
      flushPending();
    } catch (error) {
      fail(`invalid endpoint event: ${data} (${error?.message ?? error})`);
    }
    return;
  }
  if (event === 'message' || event === '') {
    // Protocol frames only go to stdout.
    process.stdout.write(`${data}\n`);
  }
}

/**
 * Read the SSE stream until it closes.
 *
 * @returns {Promise<void>}
 */
async function readSse() {
  const response = await fetch(sseUrl, {
    headers: { ...headers, accept: 'text/event-stream' },
    redirect: Object.keys(headers).length ? 'error' : 'follow',
    signal: abortController.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    fail(`SSE GET ${response.status}: ${text.slice(0, 300)}`);
  }
  if (response.body === null) {
    fail('SSE response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data = [];

  while (!closed) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (line === '') {
        dispatch(event, data.join('\n'));
        event = 'message';
        data = [];
      } else if (line.startsWith(':')) {
        // Comment/keep-alive.
      } else {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
        if (fieldValue.startsWith(' ')) {
          fieldValue = fieldValue.slice(1);
        }
        if (field === 'event') {
          event = fieldValue;
        } else if (field === 'data') {
          data.push(fieldValue);
        }
      }
      newline = buffer.indexOf('\n');
    }
  }

  if (!closed) {
    log('SSE stream closed');
    process.exit(1);
  }
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const text = line.trim();
  if (text === '') {
    return;
  }
  chain = chain.then(() => postFrame(text));
});
input.on('close', () => {
  closed = true;
  abortController.abort();
  chain.finally(() => {
    if (process.exitCode === undefined) {
      process.exitCode = 0;
    }
  });
});

readSse().catch((error) => {
  if (!closed) {
    fail(`SSE connection failed: ${error?.message ?? error}`);
  }
});

// Fail fast if the server never advertises a POST endpoint.
const endpointTimer = setTimeout(() => {
  if (!endpointReady) {
    fail('timed out waiting for the SSE endpoint event', 1);
  }
}, 30_000);
endpointTimer.unref?.();
