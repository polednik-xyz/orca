import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../../store/index'
import { useOrcaProfileAuthStatusRefresh } from '@/components/orca-profiles/use-orca-profile-auth-status-refresh'
import { useOrcaTeamFeatureBlocked } from '@/lib/orca-team-policy'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../../../../shared/orca-profiles/orca-cloud-team-policy'
import { OrcaSignInButton, OrcaSignInWaitNotice } from '../../../orca-profiles/OrcaSignInProgress'

type RuntimeRelayShareState = 'ready' | 'sign-in' | 'reconnect' | 'unavailable'

export function useRuntimeRelayShareState(): RuntimeRelayShareState {
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const blocked = useOrcaTeamFeatureBlocked(ORCA_CLOUD_TEAM_POLICY_FLAGS.mobileRelay)
  if (blocked) {
    return 'unavailable'
  }
  if (authStatus?.state === 'connected') {
    return 'ready'
  }
  // Unconfigured builds have no Relay sign-in endpoint, so a Sign in button would be dead.
  if (authStatus?.configured === false) {
    return 'unavailable'
  }
  return authStatus?.state === 'reconnect-required' ? 'reconnect' : 'sign-in'
}

export function RuntimeRelaySharePanel({
  state
}: {
  state: RuntimeRelayShareState
}): React.JSX.Element {
  const t = useTranslate()
  const browserWaiting = useAppStore((store) => Boolean(store.orcaProfileSignInProgress?.link))
  useOrcaProfileAuthStatusRefresh()
  const needsSignIn = state === 'sign-in' || state === 'reconnect'

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
      <div className="font-medium">
        {t('auto.components.settings.RuntimeRelaySharePanel.title', 'Orca Relay')}
      </div>
      {needsSignIn && browserWaiting ? (
        <OrcaSignInWaitNotice />
      ) : (
        <p className="text-muted-foreground">
          {state === 'unavailable'
            ? t(
                'auto.components.settings.RuntimeRelaySharePanel.unavailable',
                'Orca Relay isn’t available here. Share over LAN, Tailscale, or a custom address.'
              )
            : state === 'ready'
              ? t(
                  'auto.components.settings.RuntimeRelaySharePanel.ready',
                  'The other Orca tries this computer’s LAN or Tailscale address first, then Orca Relay. Traffic stays end-to-end encrypted.'
                )
              : t(
                  'auto.components.settings.RuntimeRelaySharePanel.signInRequired',
                  'Sign in to an Orca account to share through Orca Relay.'
                )}
        </p>
      )}
      {needsSignIn ? (
        <OrcaSignInButton size="sm">
          {state === 'reconnect'
            ? t(
                'auto.components.settings.RuntimeRelaySharePanel.signInAgain',
                'Sign in again for Relay'
              )
            : t('auto.components.settings.RuntimeRelaySharePanel.signIn', 'Sign in for Relay')}
        </OrcaSignInButton>
      ) : null}
    </div>
  )
}
