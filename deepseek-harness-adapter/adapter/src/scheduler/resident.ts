import { spawn, type ChildProcess } from 'node:child_process';

import type { AdapterFrame, ChildRunResult, InvocationEnvelope } from '../types.js';

/** Lifecycle of a resident child process. */
export type ResidentState = 'init' | 'starting' | 'ready' | 'crashed';

/** Immutable launch spec for a resident process (stdin stays open across rounds). */
export interface ResidentSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

interface ReadyGate {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveInvoke {
  readonly frames: AdapterFrame[];
  readonly resolve: (result: ChildRunResult) => void;
  readonly timer: NodeJS.Timeout;
  readonly startedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One pre-mounted child process that stays alive across rounds. Envelopes are
 * written as one NDJSON line per round; the process answers with NDJSON frames
 * and, after the final frame, keeps waiting for the next envelope. Success is
 * derived from final.reason.kind === 'completed', never from the exit code.
 */
export class ResidentProcess {
  private state: ResidentState = 'init';
  private child?: ChildProcess;
  private stdoutBuffer = '';
  private stderr = '';
  private readyGate?: ReadyGate;
  private active?: ActiveInvoke;
  private lastExit?: { readonly code: number | null; readonly signal: NodeJS.Signals | null };

  constructor(private readonly spec: ResidentSpec) {}

  get ready(): boolean {
    return this.state === 'ready';
  }

  get stateName(): ResidentState {
    return this.state;
  }

  get lastExitInfo():
    { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined {
    return this.lastExit;
  }

  /** Spawn the resident process and wait for its `ready` frame. */
  async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'starting') throw new Error('resident process is already starting');
    this.state = 'starting';
    this.stderr = '';
    this.stdoutBuffer = '';
    const child = spawn(this.spec.command, [...this.spec.args], {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderr += Buffer.byteLength(this.stderr) < MAX_STDERR_BYTES ? chunk : '';
    });
    child.once('error', (error) => this.onExit(null, null, error.message));
    child.once('close', (code, signal) => this.onExit(code, signal));

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`resident process did not become ready within ${this.spec.timeoutMs}ms`),
            ),
          this.spec.timeoutMs,
        );
        timer.unref();
        this.readyGate = { resolve, reject, timer };
      });
    } catch (error) {
      this.state = 'crashed';
      throw error;
    }
    this.readyGate = undefined;
    this.state = 'ready';
  }

  /** Run one round by writing an envelope line and waiting for its final frame. */
  async invoke(envelope: InvocationEnvelope): Promise<ChildRunResult> {
    if (this.state !== 'ready') await this.start();
    if (this.child === undefined) throw new Error('resident process is not running');
    if (this.active !== undefined)
      throw new Error('resident process is busy; serialize invocations per session');
    const startedAt = Date.now();
    return new Promise<ChildRunResult>((resolve) => {
      const timer = setTimeout(
        () => this.settle(`round timed out after ${this.spec.timeoutMs}ms`),
        this.spec.timeoutMs,
      );
      timer.unref();
      this.active = { frames: [], resolve, timer, startedAt };
      this.child!.stdin!.write(`${JSON.stringify(envelope)}\n`);
    });
  }

  /** Stop the resident process. */
  async dispose(): Promise<void> {
    if (this.child !== undefined) {
      this.child.kill();
      this.child = undefined;
    }
    this.state = 'init';
    this.settle('disposed');
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.consumeLine(line);
    }
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_FRAME_BYTES) {
      this.stdoutBuffer = '';
      this.settle(`stdout line exceeded ${MAX_FRAME_BYTES} bytes`);
    }
  }

  private consumeLine(line: string): void {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized.trim() === '') return;
    if (Buffer.byteLength(normalized) > MAX_FRAME_BYTES) {
      this.settle(`stdout line exceeded ${MAX_FRAME_BYTES} bytes`);
      return;
    }
    let frame: AdapterFrame;
    try {
      const value: unknown = JSON.parse(normalized);
      if (!isRecord(value)) {
        this.settle('stdout line is not a JSON object');
        return;
      }
      frame = value as AdapterFrame;
    } catch {
      this.settle('stdout line is not valid NDJSON');
      return;
    }

    if (frame['type'] === 'ready' && this.readyGate !== undefined) {
      clearTimeout(this.readyGate.timer);
      this.readyGate.resolve();
      this.readyGate = undefined;
      return;
    }

    if (this.active === undefined) return;
    this.active.frames.push(frame);
    if (frame['type'] === 'final' || frame['type'] === 'error') this.settle();
  }

  private settle(error?: string): void {
    const active = this.active;
    if (active === undefined) return;
    clearTimeout(active.timer);
    this.active = undefined;
    const terminal = [...active.frames].reverse().find((frame) => frame['type'] === 'final');
    const completed =
      error === undefined &&
      terminal !== undefined &&
      isRecord(terminal['reason']) &&
      terminal['reason']['kind'] === 'completed';
    const frameError = active.frames.find((frame) => frame['type'] === 'error');
    const errors = [error];
    if (frameError !== undefined)
      errors.push(`child error frame: ${String(frameError['message'] ?? 'unknown error')}`);
    const message = errors.filter((item): item is string => item !== undefined).join('; ');
    active.resolve({
      ok: completed,
      exitCode: null,
      signal: null,
      frames: active.frames,
      ...(terminal === undefined ? {} : { final: terminal }),
      stderr: this.stderr,
      ...(message === '' ? {} : { error: message }),
      durationMs: Date.now() - active.startedAt,
    });
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void {
    this.state = 'crashed';
    this.lastExit = { code, signal };
    this.child = undefined;
    if (this.readyGate !== undefined) {
      clearTimeout(this.readyGate.timer);
      this.readyGate.reject(
        new Error(
          spawnError ??
            `resident process exited during startup (code ${String(code)}, signal ${signal ?? 'none'})`,
        ),
      );
      this.readyGate = undefined;
    }
    this.settle(
      spawnError ?? `resident process exited (code ${String(code)}, signal ${signal ?? 'none'})`,
    );
  }
}
