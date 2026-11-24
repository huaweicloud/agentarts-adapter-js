// 假 dsh 子进程：按 AGENTRUN_TEST_MODE 模拟各种一轮行为，帧走 stdout，诊断走 stderr。
// 仅测试用，不是交付代码。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.AGENTRUN_TEST_MODE ?? 'normal'
const sessionId = process.env.AGENTRUN_DSH_SESSION_ID ?? 's'
const eventId = process.env.AGENTRUN_EVENT_ID ?? 'e'

// stubborn 模式：捕获并忽略 SIGTERM，验证取消的宽限后 SIGKILL 升级
if (mode === 'stubborn') {
    process.on('SIGTERM', () => { process.stderr.write('sigterm-ignored\n') })
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', async () => {
    const emit = (f) => process.stdout.write(JSON.stringify(f) + '\n')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    emit({ type: 'session', sessionId, cwd: '/tmp' })
    if (mode === 'garbage') {
        process.stdout.write('{not json\n')
        await sleep(5000)   // 等被 kill
        return
    }
    emit({ type: 'status', phase: 'turn_start' })
    // flood：快速吐 3000 个 delta，尊重 stdout 背压（写满等 drain），验证慢消费者限流
    if (mode === 'flood') {
        for (let i = 0; i < 3000; i++) {
            const ok = process.stdout.write(JSON.stringify({
                type: 'delta', kind: 'text', text: `t${i}`, attemptId: 'a1', revision: i,
            }) + '\n')
            if (!ok) await new Promise((r) => process.stdout.once('drain', r))
        }
        emit({ type: 'final', text: 'flood-done', reason: { kind: 'completed' }, sessionId })
        return
    }
    if (mode === 'slow') await sleep(150)
    emit({ type: 'delta', kind: 'text', text: `echo:${input}`, attemptId: 'a1', revision: 0 })
    // final 后 flush 失败：先写 final 再以 1 退出
    if (mode === 'final-then-fail') {
        emit({ type: 'final', text: `echo:${input}`, reason: { kind: 'completed' }, sessionId })
        process.stderr.write('flush failed\n')
        process.exitCode = 1
        return
    }
    // 裸 final（缺字段）以 0 退出
    if (mode === 'bare-final') {
        process.stdout.write(JSON.stringify({ type: 'final' }) + '\n')
        return
    }
    // hang/stubborn：长时间挂起（计时器保持事件循环存活），等超时或取消来终止
    if (mode === 'hang' || mode === 'stubborn') { await sleep(3600_000); return }
    if (mode === 'fail') {
        process.stderr.write('model exploded\n')
        emit({ type: 'error', message: 'model exploded' })
        // 不用 process.exit()：它会截断未刷出的管道写入，偶发丢帧；
        // 设 exitCode 后自然退出，事件循环排空时 stdout 保证刷出
        process.exitCode = 1
        return
    }
    if (mode === 'nofinal') return
    emit({ type: 'final', text: `echo:${input}`, reason: { kind: 'completed' }, sessionId })
    // 模拟 driver 的 flush：final 之后、退出之前落盘
    if (process.env.AGENTRUN_TEST_FLUSH_DIR) {
        writeFileSync(
            join(process.env.AGENTRUN_TEST_FLUSH_DIR, `flush-${sessionId}-${eventId}.json`),
            JSON.stringify({ text: `echo:${input}` }),
        )
    }
    // 自然退出（exitCode 默认 0），避免 final 帧被截断
})