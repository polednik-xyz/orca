import { describe, expect, it } from 'vitest'
import { createPairingOfferSchema } from './mobile-relay-pairing-offer'
import { createMobileRelayPairingFixtures } from '../relay/mobile-relay-pairing-fixtures'

const NOW = 1_800_000_000_000

describe('pairing offer schema', () => {
  const schema = createPairingOfferSchema(() => NOW)
  it.each(createMobileRelayPairingFixtures(NOW))('$name', ({ payload, expected }) => {
    const parsed = schema.safeParse(payload)
    expect(parsed.success ? parsed.data : null).toEqual(expected)
  })
})
