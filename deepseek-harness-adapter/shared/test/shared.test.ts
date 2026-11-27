import { expect, it } from 'vitest'
import { AGENT_METADATA_ENV, MODEL_API_KEY_ENV } from '../src/index.js'

it('exports the metadata and model credential keys used by the adapter', () => {
    expect(AGENT_METADATA_ENV).toBe('agent_metadata')
    expect(MODEL_API_KEY_ENV).toBe('MODEL_API_KEY')
})
