import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import { buildChildEnv } from '../config.js';
import {
  resolveCredentials,
  SdkCredentialProvider,
  type CredentialProvider,
  type ResolvedCredentials,
} from '../credential.js';
import { AdapterOps } from '../ops.js';
import { materializeProfile } from '../patch.js';
import type {
  AdapterConfig,
  AdapterFrame,
  ChildRunResult,
  InvocationRequest,
  RecallBundle,
  ReconcileReport,
} from '../types.js';
import { SessionQueue } from './session-queue.js';

/** Fully resolved one-shot process invocation. */
export interface ChildProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: string;
  readonly timeoutMs: number;
}

/** Raw text result used for --dump-config. */
export interface TextChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly durationMs: number;
}

interface CapturedProcess {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly durationMs: number;
}

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

async function spawnCaptured(
  spec: ChildProcessSpec,
  onStdout?: (chunk: string) => void,
): Promise<CapturedProcess> {
  const startedAt = Date.now();
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  let processError: string | undefined;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > MAX_STDOUT_BYTES) {
      processError ??= `child stdout exceeded ${MAX_STDOUT_BYTES} bytes`;
      child.kill();
      return;
    }
    stdout += chunk;
    onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) stderr += chunk;
  });
  child.once('error', (error) => {
    processError ??= `failed to spawn ${spec.command}: ${error.message}`;
  });
  child.stdin.on('error', (error) => {
    processError ??= `failed to write child stdin: ${error.message}`;
  });
  child.stdin.end(spec.stdin);
  const timer = setTimeout(() => {
    timedOut = true;
    processError ??= `child timed out after ${spec.timeoutMs}ms`;
    child.kill();
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    killTimer.unref();
  }, spec.timeoutMs);
  timer.unref();
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    },
  );
  clearTimeout(timer);
  if (killTimer !== undefined) clearTimeout(killTimer);
  if (timedOut) processError ??= `child timed out after ${spec.timeoutMs}ms`;
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout,
    stderr:
      Buffer.byteLength(stderr) >= MAX_STDERR_BYTES ? `${stderr}\n<stderr truncated>` : stderr,
    ...(processError === undefined ? {} : { error: processError }),
    durationMs: Date.now() - startedAt,
  };
}

/** Run DSH --dump-config or another text-producing child with the same lifecycle guarantees. */
export async function runChildText(spec: ChildProcessSpec): Promise<TextChildResult> {
  const result = await spawnCaptured(spec);
  return { ...result };
}

interface FrameParser {
  readonly frames: AdapterFrame[];
  readonly error?: string;
  push(chunk: string): void;
  finish(): void;
}

function createFrameParser(): FrameParser {
  const frames: AdapterFrame[] = [];
  let buffer = '';
  let lineNumber = 0;
  let error: string | undefined;
  const consume = (line: string): void => {
    lineNumber += 1;
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized.trim() === '') return;
    if (Buffer.byteLength(normalized) > MAX_FRAME_BYTES) {
      error ??= `stdout frame ${lineNumber} exceeded ${MAX_FRAME_BYTES} bytes`;
      return;
    }
    try {
      const value: unknown = JSON.parse(normalized);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        error ??= `stdout frame ${lineNumber} is not a JSON object`;
        return;
      }
      frames.push(value as AdapterFrame);
    } catch {
      error ??= `stdout frame ${lineNumber} is not valid NDJSON`;
    }
  };
  return {
    frames,
    get error() {
      return error;
    },
    push(chunk: string): void {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        error ??= `stdout frame ${lineNumber + 1} exceeded ${MAX_FRAME_BYTES} bytes`;
        buffer = '';
      }
    },
    finish(): void {
      if (buffer.length > 0) consume(buffer);
      buffer = '';
    },
  };
}

function completedFinal(frames: readonly AdapterFrame[]): { final?: AdapterFrame; error?: string } {
  const final = [...frames].reverse().find((frame) => frame.type === 'final');
  if (final === undefined) return { error: 'child exited without a final frame' };
  const reason = final['reason'];
  if (
    typeof reason !== 'object' ||
    reason === null ||
    (reason as Record<string, unknown>)['kind'] !== 'completed'
  ) {
    return { final, error: 'final frame did not complete successfully' };
  }
  return { final };
}

/** Spawn a child, parse NDJSON and require exitCode=0 plus final.reason.kind=completed. */
export async function runChildProcess(spec: ChildProcessSpec): Promise<ChildRunResult> {
  const parser = createFrameParser();
  const result = await spawnCaptured(spec, parser.push);
  parser.finish();
  const terminal = completedFinal(parser.frames);
  const frameError = parser.frames.find((frame) => frame.type === 'error');
  const errors = [result.error, parser.error, terminal.error];
  if (frameError !== undefined)
    errors.push(`child error frame: ${String(frameError['message'] ?? 'unknown error')}`);
  if (result.exitCode !== 0)
    errors.push(
      `child exited with code ${String(result.exitCode)}${result.signal ? ` (${result.signal})` : ''}`,
    );
  const error = errors.filter((item): item is string => item !== undefined).join('; ');
  return {
    ok: error === '',
    exitCode: result.exitCode,
    signal: result.signal,
    frames: parser.frames,
    ...(terminal.final === undefined ? {} : { final: terminal.final }),
    stderr: result.stderr,
    ...(error === '' ? {} : { error }),
    durationMs: result.durationMs,
  };
}

function launcherArgs(config: AdapterConfig): string[] {
  const args = [...config.dsh.args, '--profile', config.dsh.profile];
  for (const patch of config.dsh.patches) args.push('--patch', patch);
  return args;
}

/** Serialize one invocation with its recall into the stdin envelope written to the child. */
function envelopeJson(invocation: InvocationRequest, recall: RecallBundle): string {
  return JSON.stringify({
    sessionId: invocation.sessionId,
    eventId: invocation.eventId,
    attempt: invocation.attempt,
    prompt: invocation.prompt,
    recall,
  });
}

/** Build the exact DSH argv/env/stdin for dump or official headless execution. */
export function buildDshProcessSpec(
  config: AdapterConfig,
  invocation: InvocationRequest,
  recall: RecallBundle,
  mode: 'dump' | 'run',
  credentials?: ResolvedCredentials,
): ChildProcessSpec {
  const args = launcherArgs(config);
  if (mode === 'dump') args.push('--dump-config');
  else {
    args.push('--json', '--approval-policy', 'never');
    if (invocation.sessionId !== undefined) args.push('--session-id', invocation.sessionId);
    args.push('-');
  }
  return {
    command: config.dsh.command,
    args,
    cwd: config.dsh.cwd,
    env: buildChildEnv(config, process.env, credentials),
    stdin: mode === 'run' ? envelopeJson(invocation, recall) : '',
    timeoutMs: config.dsh.timeoutMs,
  };
}

/** Successful DSH composition and its ops report. */
export interface PreparationResult {
  readonly snapshot: NonNullable<ReturnType<AdapterOps['snapshot']>>;
  readonly reconcile: ReconcileReport;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Profile + process launcher. prepare runs once per Adapter instance; each run creates a fresh child. */
export class DshLauncher {
  readonly ops = new AdapterOps();
  private preparation?: PreparationResult;

  constructor(
    readonly config: AdapterConfig,
    readonly credentialProvider: CredentialProvider = SdkCredentialProvider.fromRegion(),
  ) {}

  /** Materialize the profile and ask the real DSH CLI to compose and validate it without mounting plugins. */
  async prepare(invocation: InvocationRequest, recall: RecallBundle): Promise<PreparationResult> {
    mkdirSync(this.config.dsh.cwd, { recursive: true });
    const rendered = materializeProfile(this.config);
    const spec = buildDshProcessSpec(this.config, invocation, recall, 'dump');
    const result = await runChildText(spec);
    if (result.exitCode !== 0 || result.error !== undefined) {
      throw new Error(
        `DSH --dump-config failed: ${result.error ?? `exit ${String(result.exitCode)}`}; ${result.stderr}`,
      );
    }
    const snapshot = this.ops.capture(rendered, result.stdout, this.config.dsh.patches.length > 0);
    this.preparation = {
      snapshot,
      reconcile: this.ops.reconcile(),
      stderr: result.stderr,
      durationMs: result.durationMs,
    };
    return this.preparation;
  }

  private async requirePreparation(
    invocation: InvocationRequest,
    recall: RecallBundle,
  ): Promise<PreparationResult> {
    const preparation = this.preparation ?? (await this.prepare(invocation, recall));
    if (!preparation.reconcile.ok)
      throw new Error(`profile reconciliation failed: ${JSON.stringify(preparation.reconcile)}`);
    return preparation;
  }

  /** Run one task through the official headless runner. */
  async run(invocation: InvocationRequest, recall: RecallBundle): Promise<ChildRunResult> {
    await this.requirePreparation(invocation, recall);
    const credentials = await resolveCredentials(
      this.config,
      this.credentialProvider,
      AbortSignal.timeout(this.config.dsh.timeoutMs),
    );
    return runChildProcess(
      buildDshProcessSpec(this.config, invocation, recall, 'run', credentials),
    );
  }

  /** Run the demo probe with exactly the same env/stdin, without substituting it for DSH --dump-config. */
  async probe(
    probePath: string,
    invocation: InvocationRequest,
    recall: RecallBundle,
  ): Promise<ChildRunResult> {
    await this.requirePreparation(invocation, recall);
    const credentials = await resolveCredentials(
      this.config,
      this.credentialProvider,
      AbortSignal.timeout(this.config.dsh.timeoutMs),
    );
    const dshSpec = buildDshProcessSpec(this.config, invocation, recall, 'run', credentials);
    return runChildProcess({ ...dshSpec, command: process.execPath, args: [probePath] });
  }
}

/** Session-serializing pool; the SDK-owned global concurrency limit remains outside this package. */
export class AdapterPool {
  private readonly queue = new SessionQueue();

  constructor(readonly launcher: DshLauncher) {}

  /** Serialize every operation for one session; fresh sessions use eventId as their temporary queue key. */
  async run(invocation: InvocationRequest, recall: RecallBundle): Promise<ChildRunResult> {
    const key = invocation.sessionId ?? `new:${invocation.eventId}`;
    return this.queue.runExclusive(key, () => this.launcher.run(invocation, recall));
  }

  /** Demo counterpart of run, retaining the same session serialization. */
  async probe(
    probePath: string,
    invocation: InvocationRequest,
    recall: RecallBundle,
  ): Promise<ChildRunResult> {
    const key = invocation.sessionId ?? `new:${invocation.eventId}`;
    return this.queue.runExclusive(key, () => this.launcher.probe(probePath, invocation, recall));
  }
}
