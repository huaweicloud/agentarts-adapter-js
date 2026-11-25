/**
 * 进程级冒烟：启动真实构建产物 adapter/dist/main.js，经真实 HTTP/WS 验证：
 * 启动探活 /ping、/invocations 参数校验（400）与子进程 spawn 失败（500 + session 头）、
 * WS 错误帧与连接复用。不依赖真 dsh——成功路径由 adapter 集成测试覆盖
 * （真 SDK app + 真子进程 fixture）；真 dsh 端到端冒烟待 driver 侧就绪后补充。
 *
 * 用法：pnpm smoke（先构建），或构建后 node scripts/smoke.mjs。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADAPTER = fileURLToPath(new URL('../adapter/', import.meta.url))
const results = []

function check(name, ok, detail) {
    results.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}

/** 取一个空闲端口：让 OS 分配后释放，避免固定端口冲突 */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address()
            srv.close(() => resolve(port))
        })
    })
}

/** 发一轮 payload，等首帧返回 */
function wsRound(ws, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws 等帧超时')), 8000)
        ws.addEventListener('message', (e) => {
            clearTimeout(timer)
            resolve(JSON.parse(String(e.data)))
        }, { once: true })
        ws.send(JSON.stringify(payload))
    })
}

async function main() {
    const mainJs = join(ADAPTER, 'dist', 'main.js')
    if (!existsSync(mainJs)) {
        console.error('未找到 adapter/dist/main.js，请先构建：pnpm build')
        process.exit(1)
    }
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const server = spawn(process.execPath, ['dist/main.js'], {
        cwd: ADAPTER,
        // 清空程序搜索路径：spawn('dsh') 必然 ENOENT，冒烟走确定的失败路径；
        // 否则装有真 dsh 的机器会误启动真实会话且断言失败（密封性）
        env: { ...process.env, PORT: String(port), PATH: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    server.stdout.on('data', (d) => { logs += d })
    server.stderr.on('data', (d) => { logs += d })
    server.on('error', (e) => { logs += `spawn error: ${e.message}\n` })

    let ws = null
    try {
        // 等 /ping 就绪（最多 10s）
        let ping = null
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
            try { ping = await fetch(`${base}/ping`); if (ping.ok) break } catch {}
            await new Promise((r) => setTimeout(r, 200))
        }
        check('服务启动 + GET /ping', !!ping && ping.ok,
            ping ? `HTTP ${ping.status} ${await ping.text()}` : '未就绪')

        // 400：缺 prompt
        const bad = await fetch(`${base}/invocations`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
        const badBody = await bad.json()
        check('POST /invocations 缺 prompt → 400',
            bad.status === 400 && badBody.error?.message === 'prompt is required',
            `HTTP ${bad.status} ${JSON.stringify(badBody)}`)

        // 5xx：合法请求但 dsh 不存在 → ACP 子进程启动失败，响应头带 sessionId
        const res = await fetch(`${base}/invocations`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 's1', prompt: 'hello', eventId: 'e1', attempt: 1 }),
        })
        const body = await res.json()
        const session = res.headers.get('x-hw-agentarts-session-id')
        check('POST /invocations ACP 启动失败 → 5xx + session 头',
            res.status >= 500 && /acp|exited|ENOENT|not recognized/i.test(body.error?.message || '')
                && session === 's1',
            `HTTP ${res.status} ${JSON.stringify(body)} session=${session}`)

        // WS：非法 payload 回 error 帧且连接可复用；合法 payload 走 ACP 失败 error 帧
        ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true })
            ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true })
        })
        const f1 = await wsRound(ws, { sessionId: 's' })
        check('WS 非法 payload → error 帧',
            f1.type === 'error' && f1.message === 'prompt is required', JSON.stringify(f1))
        const f2 = await wsRound(ws, { prompt: 'x' })
        check('WS ACP 启动失败 → error 帧',
            f2.type === 'error' && /acp|exited|ENOENT|not recognized/i.test(f2.message || ''),
            JSON.stringify(f2))
        check('WS 错误后连接仍可复用', ws.readyState === WebSocket.OPEN,
            `readyState=${ws.readyState}`)
    } finally {
        ws?.close()
        server.kill()
        await new Promise((r) => setTimeout(r, 300))
        console.log('--- 服务启动日志 ---')
        console.log(logs.trim() || '(无)')
        const failed = results.filter((r) => !r.ok).length
        console.log(`=== ${results.length - failed}/${results.length} 项通过 ===`)
        process.exitCode = failed ? 1 : 0
    }
}

main().catch((e) => { console.error('SMOKE ERROR:', e); process.exit(1) })