import type { AgentContext } from '@agentarts/shared';

/** 处理发往 Agent 的请求（占位实现，待按 AgentArts 协议填充）。 */
export class AgentRequestHandler {
  handle(ctx: AgentContext): string {
    return `handled:${ctx.agentId}`;
  }
}
