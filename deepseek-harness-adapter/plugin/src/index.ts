import { banner } from '@agentarts/helper';

/** AgentArts 平台侧插件（占位实现，待定义与平台对接的扩展点）。 */
export class Plugin {
  readonly name = 'agentarts-harness-plugin';

  activate(): string {
    return banner();
  }
}
