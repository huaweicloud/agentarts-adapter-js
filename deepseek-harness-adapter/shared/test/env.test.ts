import { describe, expect, it } from 'vitest'
import {
    ENV_SESSION_ID, ENV_EVENT_ID, ENV_ATTEMPT, ENV_SYSTEM_PROMPT, ENV_RECALL_RESULT,
    INSTRUMENTATION_ENV, readInstrumentationChildEnv,
} from '../src/index.js'

describe('AGENTRUN_* 常量（契约值）', () => {
    it('变量名与设计一致', () => {
        expect(ENV_SESSION_ID).toBe('AGENTRUN_DSH_SESSION_ID')
        expect(ENV_EVENT_ID).toBe('AGENTRUN_EVENT_ID')
        expect(ENV_ATTEMPT).toBe('AGENTRUN_ATTEMPT')
        expect(ENV_SYSTEM_PROMPT).toBe('AGENTRUN_SYSTEM_PROMPT')
        expect(ENV_RECALL_RESULT).toBe('AGENTRUN_RECALL_RESULT')
    })
})

describe('INSTRUMENTATION_ENV（agentarts-instrumentation-dsh 观测环境变量契约）', () => {
    it('覆盖插件读取的全部 otel 配置键（adapter 侧大写命名）', () => {
        expect(INSTRUMENTATION_ENV).toHaveLength(11)
        expect(INSTRUMENTATION_ENV).toEqual([
            'AGENTARTS_AGENTOPS_OTEL_AGENT_APM_ENABLE',
            'AGENTARTS_AGENTOPS_OTEL_AGENT_AOM_ENABLE',
            'AGENTARTS_AGENTOPS_APM_TOKEN',
            'AGENTARTS_AGENTOPS_APM_EXPORTER_ENDPOINT',
            'AGENTARTS_AGENTOPS_AOM_ACCESS_CODE',
            'AGENTARTS_AGENTOPS_AOM_EXPORTER_ENDPOINT',
            'AGENTARTS_AGENTOPS_AOM_PROMETHEUS_ID',
            'AGENT_DOMAIN_ID',
            'AGENTARTS_PROJECT_ID',
            'AGENT_RESOURCE_ID',
            'RESOURCE_TYPE',
        ])
    })

    it('归一化为插件要求的小写键名，接受大小写两种输入', () => {
        expect(readInstrumentationChildEnv({
            AGENTARTS_AGENTOPS_APM_TOKEN: 'upper',
            agentarts_agentops_apm_exporter_endpoint: 'lower',
            AGENT_DOMAIN_ID: 'domain',
            UNRELATED: 'x',
        })).toEqual({
            agentarts_agentops_apm_token: 'upper',
            agentarts_agentops_apm_exporter_endpoint: 'lower',
            agent_domain_id: 'domain',
        })
        // 未设置时输出为空；大写命中优先于小写。
        expect(readInstrumentationChildEnv({ AGENTARTS_AGENTOPS_APM_TOKEN: 'u', agentarts_agentops_apm_token: 'l' }))
            .toEqual({ agentarts_agentops_apm_token: 'u' })
        expect(readInstrumentationChildEnv({})).toEqual({})
    })
})
