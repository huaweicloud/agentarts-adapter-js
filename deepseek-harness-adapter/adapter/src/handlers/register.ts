import type { SchedulerLike } from '../scheduler/types.js'
import { TaskRegistry, createA2AHandler } from './a2a.js'
import { createAguiHandler } from './agui.js'

/** SDK 新协议面的最小形状约定（app.a2a/app.agui 风格注册） */
interface ProtocolSurface {
    a2a?: (handler: unknown) => void
    agui?: (handler: unknown) => void
}

/**
 * 守卫注册：SDK 的 A2A/AG-UI 注册接口尚未就绪，未到位时跳过并告警，
 * 三端点不受影响。SDK 到位后若 API 形状不同，只需调整本文件。
 */
export function registerProtocolFaces(
    app: unknown, scheduler: SchedulerLike, registry: TaskRegistry,
): void {
    const surface = app as ProtocolSurface
    if (typeof surface.a2a === 'function') {
        surface.a2a(createA2AHandler(scheduler, registry))
    } else {
        console.warn('[adapter] SDK a2a 注册接口尚未就绪，跳过注册（就绪后自动生效）')
    }
    if (typeof surface.agui === 'function') {
        surface.agui(createAguiHandler(scheduler))
    } else {
        console.warn('[adapter] SDK agui 注册接口尚未就绪，跳过注册（就绪后自动生效）')
    }
}