import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Frame, LaunchSpec } from '@agentarts/harness-dsh-shared'
import type { AgentArtsRuntimeApp } from '@huaweicloud/agentarts-sdk/sdk/runtime'

/** 假子进程 fixture 路径（BUG-10：统一出口，契约变更只改这里） */
export const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))

/** 构造指向 fixture 的 LaunchSpec；extraEnv 覆盖/补充环境变量 */
export function fakeSpec(mode = 'normal', extraEnv: Record<string, string> = {}): LaunchSpec {
    return {
        command: process.execPath,
        args: [fixture],
        env: { ...process.env, AGENTRUN_TEST_MODE: mode, ...extraEnv } as Record<string, string>,
        encodeStdin: (t) => t,
    }
}

/** 排空帧流成数组 */
export async function collect(frames: AsyncIterable<Frame>): Promise<Frame[]> {
    const out: Frame[] = []
    for await (const f of frames) out.push(f)
    return out
}

/** 随机端口启动 app 并等 listening；close 由调用方 afterEach 负责（BUG-09 形态） */
export async function listen(app: AgentArtsRuntimeApp): Promise<{ server: Server; base: string }> {
    const server = app.run('127.0.0.1', 0)
    await new Promise((r) => server.once('listening', r))
    const port = (server.address() as AddressInfo).port
    return { server, base: `127.0.0.1:${port}` }
}