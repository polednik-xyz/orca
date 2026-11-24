import type { Translate } from '@/i18n/use-translate'
import type { RuntimePairingIntent } from './runtime-pairing-link-state'

export type RuntimePairingIntentOption = {
  value: RuntimePairingIntent
  label: string
  description: string
}

export function runtimePairingIntentOptions(t: Translate): RuntimePairingIntentOption[] {
  return [
    {
      value: 'another',
      label: t(
        'auto.components.settings.RuntimePairingUrlGenerator.anotherDevice',
        'Another device'
      ),
      description: t(
        'auto.components.settings.RuntimePairingUrlGenerator.anotherDeviceHelp',
        'Tailscale, LAN, or another reachable address'
      )
    },
    {
      value: 'local',
      label: t('auto.components.settings.RuntimePairingUrlGenerator.thisComputer', 'This computer'),
      description: t(
        'auto.components.settings.RuntimePairingUrlGenerator.localOnlyHelp',
        'A browser or Orca client on this computer'
      )
    },
    {
      value: 'custom',
      label: t(
        'auto.components.settings.RuntimePairingUrlGenerator.customAddress',
        'Custom address'
      ),
      description: t(
        'auto.components.settings.RuntimePairingUrlGenerator.customAddressHelp',
        'SSH tunnel, reverse proxy, or custom hostname'
      )
    },
    {
      value: 'relay',
      label: t('auto.components.settings.RuntimePairingUrlGenerator.anyNetwork', 'Any network'),
      description: t(
        'auto.components.settings.RuntimePairingUrlGenerator.anyNetworkHelp',
        'Through Orca Relay when there is no direct path'
      )
    }
  ]
}
