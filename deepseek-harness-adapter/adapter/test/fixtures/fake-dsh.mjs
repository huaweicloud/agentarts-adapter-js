// 假 dsh 子进程：按 AGENTRUN_TEST_MODE 模拟各种一轮行为，帧走 stdout，诊断走 stderr。
// 仅测试用，不是交付代码。
const mode = process.env.AGENTRUN_TEST_MODE ?? 'normal'
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', async () => {
    const emit = (f) => process.stdout.write(JSON.stringify(f) + '\n')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    emit({ type: 'session', sessionId: process.env.AGENTRUN_DSH_SESSION_ID ?? 's', cwd: '/tmp' })
    if (mode === 'garbage') {
        process.stdout.write('{not json\n')
        await sleep(5000)   // 等被 kill
        return
    }
    emit({ type: 'status', phase: 'turn_start' })
    if (mode === 'slow') await sleep(150)
    emit({ type: 'delta', kind: 'text', text: `echo:${input}`, attemptId: 'a1', revision: 0 })
    if (mode === 'hang') { await sleep(60000); return }
    if (mode === 'fail') {
        process.stderr.write('model exploded\n')
        emit({ type: 'error', message: 'model exploded' })
        // 不用 process.exit()：它会截断未刷出的管道写入，偶发丢帧；
        // 设 exitCode 后自然退出，事件循环排空时 stdout 保证刷出
        process.exitCode = 1
        return
    }
    if (mode === 'nofinal') return
    emit({ type: 'final', text: `echo:${input}`, reason: { kind: 'completed' },
        sessionId: process.env.AGENTRUN_DSH_SESSION_ID ?? 's' })
    // 同上：自然退出（exitCode 默认 0），避免 final 帧被截断
})