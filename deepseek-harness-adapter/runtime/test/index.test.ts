import { expect, it } from 'vitest'
import { AcpRuntime, loadConfig } from '../src/index.js'

it('exports the runtime constructor and configuration loader', () => {
    expect(AcpRuntime).toBeTypeOf('function')
    expect(loadConfig).toBeTypeOf('function')
})
