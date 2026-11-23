import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Frame, LaunchSpec } from '@agentarts/harness-dsh-shared'
import { runRound, CANCEL_GRACE_MS } from '../src/scheduler/run.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))

function spec(mode: string, sessionId = 's1'): LaunchSpec {
    return {
        command: process.execPath,
        args: [fixture],
        env: { ...process.env, AGENTRUN_TEST_MODE: mode, AGENTRUN_DSH_SESSION_ID: sessionId } as
            Record<string, string>,
        encodeStdin: (t) => t,
    }
}

async function collect(frames: AsyncIterable<Frame>): Promise<Frame[]> {
    const out: Frame[] = []
    for await (const f of frames) out.push(f)
    return out
}

describe('runRound', () => {
    it('正常一轮：帧序完整，outcome.ok，final 正确', async () => {
        const handle = runRound(spec('normal'), 'hello')
        const frames = await collect(handle.frames)
        const outcome = await handle.outcome
        expect(outcome.ok).toBe(true)
        expect(outcome.exitCode).toBe(0)
        expect(outcome.final?.text).toBe('echo:hello')
        expect(frames.map((f) => f.type)).toEqual(['session', 'status', 'delta', 'final'])
    })

    it('非 0 退出：失败，stderr 并入错误信息', async () => {
        const handle = runRound(spec('fail'), 'x')
        await collect(handle.frames)
        const outcome = await handle.outcome
        expect(outcome.ok).toBe(false)
        expect(outcome.exitCode).toBe(1)
        expect(outcome.error).toContain('model exploded')
    })

    it('exit 0 但无 final：失败', async () => {
        const handle = runRound(spec('nofinal'), 'x')
        await collect(handle.frames)
        const outcome = await handle.outcome
        expect(outcome.ok).toBe(false)
        expect(outcome.error).toContain('no final frame')
    })

    it('超时：kill 子进程并判失败', async () => {
        const handle = runRound(spec('hang'), 'x', 200)
        await collect(handle.frames)
        const outcome = await handle.outcome
        expect(outcome.ok).toBe(false)
        expect(outcome.error).toContain('timeout')
    })

    it('非法帧行：立即判失败', async () => {
        const handle = runRound(spec('garbage'), 'x', 5000)
        await collect(handle.frames)
        const outcome = await handle.outcome
        expect(outcome.ok).toBe(false)
        expect(outcome.error).toContain('invalid frame line')
    })

    it('spawn 失败（命令不存在）：失败且不挂起', async () => {
        const bad: LaunchSpec = { ...spec('normal'), command: 'no-such-cmd-xyz', args: [] }
        const handle = runRound(bad, 'x')
        await collect(handle.frames)
        const outcome = await handle.outcome
        expect(outcome.ok).toBe(false)
        expect(outcome.error).toContain('spawn failed')
    })

    it('空行跳过，不产生帧也不判失败', async () => {
        // 用 node -e 直接产出一个带空行的合法帧流
        const s: LaunchSpec = {
            command: process.execPath,
            args: ['-e', `process.stdout.write('\\n' + JSON.stringify({type:'final',text:'t',
                reason:{kind:'completed'},sessionId:'s'}) + '\\n\\n')`],
            env: process.env as Record<string, string>,
            encodeStdin: (t) => t,
        }
        const handle = runRound(s, 'x')
        const frames = await collect(handle.frames)
        const outcome = await handle.outcome
        expect(frames).toHaveLength(1)
        expect(outcome.ok).toBe(true)
    })

    it('spawn 前已取消：不启动子进程，直接 cancelled 结算（BUG-06）', async () => {
        const ac = new AbortController()
        ac.abort()
        const handle = runRound(spec('normal'), 'x', 5000, ac.signal)
        const frames = await collect(handle.frames)
        const outcome = await handle.outcome
        expect(frames).toHaveLength(0)
        expect(outcome.ok).toBe(false)
        expect(outcome.error).toContain('cancelled before spawn')
    })

    it('执行中取消：以 cancelled 结算且帧流终止（BUG-06）', async () => {
        const handle = runRound(spec('hang'), 'x', 60000)
        const iter = handle.frames[Symbol.asyncIterator]()
        const first = await iter.next()   // 等首帧真实到达，不猜启动耗时
        expect(first.done).toBe(false)
        handle.cancel()
        // 排空剩余帧：channel 在子进程 close 后终止，迭代必然结束
        for (let r = await iter.next(); !r.done; r = await iter.next()) { /* drain */ }
        const outcome = await handle.outcome
        expect(outcome.ok).toBe(false)
        expect(outcome.error).toContain('cancelled')
    })

    it('结束后取消为 no-op（幂等）', async () => {
        const handle = runRound(spec('normal'), 'x')
        await collect(handle.frames)
        const outcome = await handle.outcome
        expect(outcome.ok).toBe(true)
        handle.cancel()
        expect((await handle.outcome).ok).toBe(true)
    })

    it('stubborn 轮忽略 SIGTERM：宽限后 SIGKILL 升级仍 cancelled（BUG-06）', async () => {
        const handle = runRound(spec('stubborn'), 'x', 60000)
        const iter = handle.frames[Symbol.asyncIterator]()
        await iter.next()   // 等首帧真实到达
        const t0 = Date.now()
        handle.cancel()
        const outcome = await handle.outcome
        for (let r = await iter.next(); !r.done; r = await iter.next()) { /* drain */ }
        expect(outcome.ok).toBe(false)
        expect(outcome.error).toContain('cancelled')
        // Windows 上 SIGTERM 直接终止进程（无宽限升级可观测），仅 POSIX 断言宽限耗时
        if (process.platform !== 'win32') {
            expect(Date.now() - t0).toBeGreaterThanOrEqual(CANCEL_GRACE_MS - 100)
        }
    })
})