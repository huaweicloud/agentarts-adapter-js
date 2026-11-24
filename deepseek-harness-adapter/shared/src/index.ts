/** 项目统一标识，供各包复用。 */
export const PKG_NAME = 'agentarts-harness-adapter';

export * from './env.js';

/** 传递到 Adapter 的 Agent 上下文。 */
export interface AgentContext {
  readonly agentId: string;
  readonly traceId?: string;
}
