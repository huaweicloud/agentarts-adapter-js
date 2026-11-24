/** Per-session promise queue; rejection of one invocation never blocks the next. */
export class SessionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run one operation after all earlier operations for the same session have settled. */
  async runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }

  /** Number of session keys currently executing or queued. */
  get size(): number {
    return this.tails.size;
  }
}
