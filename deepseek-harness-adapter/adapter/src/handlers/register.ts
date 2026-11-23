import type { Scheduler } from '../scheduler/index.js'
import { TaskRegistry, createA2AHandler } from './a2a.js'
import { createAguiHandler } from './agui.js'

/** SDK 新面的最小形状约定（spec §1.4 决策 8：app.a2a/app.agui 风格注册） */
interface ProtocolSurface {
    a2a?: (handler: unknown) => void
    agui?: (handler: unknown) => void
}

/**
 * 守卫注册：SDK 的 A2A/AG-UI 面 11/30 交付，未到位时跳过并告警，
 * 三端点不受影响。SDK 到位后若 API 形状不同，只需调整本文件。
 */
export function registerProtocolFaces(
    app: unknown, scheduler: Scheduler, registry: TaskRegistry,
): void {
    const surface = app as ProtocolSurface
    if (typeof surface.a2a === 'function') {
        surface.a2a(createA2AHandler(scheduler, registry))
    } else {
        console.warn('[adapter] SDK a2a 面未交付，跳过注册（交付后自动生效）')
    }
    if (typeof surface.agui === 'function') {
        surface.agui(createAguiHandler(scheduler))
    } else {
        console.warn('[adapter] SDK agui 面未交付，跳过注册（交付后自动生效）')
    }
}