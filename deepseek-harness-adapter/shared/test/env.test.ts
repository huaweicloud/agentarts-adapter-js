import { describe, expect, it } from 'vitest'
import {
    ENV_SESSION_ID, ENV_EVENT_ID, ENV_ATTEMPT, ENV_SYSTEM_PROMPT, ENV_RECALL_RESULT,
} from '../src/index.js'

describe('AGENTRUN_* 常量（spec §3.4 契约值）', () => {
    it('变量名与设计一致', () => {
        expect(ENV_SESSION_ID).toBe('AGENTRUN_DSH_SESSION_ID')
        expect(ENV_EVENT_ID).toBe('AGENTRUN_EVENT_ID')
        expect(ENV_ATTEMPT).toBe('AGENTRUN_ATTEMPT')
        expect(ENV_SYSTEM_PROMPT).toBe('AGENTRUN_SYSTEM_PROMPT')
        expect(ENV_RECALL_RESULT).toBe('AGENTRUN_RECALL_RESULT')
    })
})