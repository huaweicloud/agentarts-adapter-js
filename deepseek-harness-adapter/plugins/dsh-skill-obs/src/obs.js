/**
 * OBS integration: object key construction, credential resolution via
 * agentarts-sdk createCredential(), and the official esdk-obs-nodejs client.
 *
 * Signing and request encoding are delegated to esdk-obs-nodejs (ObsClient.getObject),
 * so there is no hand-rolled SigV4 here. Credentials come from createCredential(),
 * whose first provider already reads HUAWEICLOUD_SDK_* environment variables.
 *
 * @module dsh-skill-obs/obs
 */

import ObsClient from 'esdk-obs-nodejs'

export const AK_ENV = 'HUAWEICLOUD_SDK_AK'
export const SK_ENV = 'HUAWEICLOUD_SDK_SK'
export const STS_ENV = 'HUAWEICLOUD_SDK_SECURITY_TOKEN'
export const OBS_ENDPOINT_ENV = 'OBS_ENDPOINT'

/** Object key of one skill zip inside the user bucket. */
export function obsObjectKey(ref) {
  return `agentarts/skills/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.name)}.zip`
}

/**
 * Resolve OBS signing credentials via agentarts-sdk createCredential().
 * The chain is environment variables -> ~/.huaweicloud/credentials -> instance metadata.
 * No extra env fallback is needed: the env provider is already the first step.
 *
 * @param {Record<string, string|undefined>} env
 * @param {() => Promise<{ak?: string, sk?: string, securityToken?: string}>} [factory] - test injection
 * @returns {Promise<{ak?: string, sk?: string, stsToken?: string}>}
 */
export async function resolveObsCredentials(env = process.env, factory) {
  if (factory !== undefined) {
    const basic = await factory()
    return { ak: basic.ak, sk: basic.sk, stsToken: basic.securityToken }
  }
  // No ".js" suffix: the package's "./sdk/*" export maps to "./dist/sdk/*.js", and an explicit
  // suffix would be appended a second time (metadata.js.js).
  const { createCredential } = await import('@huaweicloud/agentarts-sdk/sdk/utils/metadata')
  const basic = await createCredential()
  return { ak: basic.ak, sk: basic.sk, stsToken: basic.securityToken }
}

/**
 * Create an official OBS client for the resolved credentials and endpoint.
 *
 * @param {{ak?: string, sk?: string, stsToken?: string}} credentials
 * @param {string} endpoint - OBS endpoint, e.g. https://obs.cn-southwest-2.myhuaweicloud.com
 * @returns {ObsClient}
 */
export function createObsClient(credentials, endpoint) {
  return new ObsClient({
    access_key_id: credentials.ak,
    secret_access_key: credentials.sk,
    security_token: credentials.stsToken,
    server: endpoint,
  })
}
