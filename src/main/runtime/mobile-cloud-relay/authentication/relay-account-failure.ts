import { getOrcaCloudAuthConfig } from '../../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { readRelayAuthContext } from './relay-auth-context'

export type RelayAccountFailure = {
  available: false
  code: 'relay_cloud_unconfigured' | 'relay_sign_in_required' | 'relay_not_entitled'
  guidance: string
}

// Why: the Relay coordinator reports both "signed out" and "not entitled" as offline, so
// the person sharing needs this read to learn which account step is missing.
export async function readRelayAccountFailure(
  signInGuidance: string
): Promise<RelayAccountFailure | null> {
  const cloudAuth = getOrcaCloudAuthConfig()
  if (!cloudAuth.configured) {
    return { available: false, code: 'relay_cloud_unconfigured', guidance: cloudAuth.setupMessage }
  }
  let context: Awaited<ReturnType<typeof readRelayAuthContext>>
  try {
    context = await readRelayAuthContext(cloudAuth.config, getProfileUserDataPath())
  } catch {
    // Why: a transient read failure is not an account verdict; the mint reports its own failure.
    return null
  }
  if (!context) {
    return { available: false, code: 'relay_sign_in_required', guidance: signInGuidance }
  }
  if (!context.relayEntitled) {
    return {
      available: false,
      code: 'relay_not_entitled',
      guidance: 'The signed-in Orca account does not include Relay access.'
    }
  }
  return null
}
