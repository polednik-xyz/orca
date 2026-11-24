import { describe, expect, it } from 'vitest'
import { normalizeProjectGroups } from './project-groups'

const persisted = { id: 'g', name: 'Clients', tabOrder: 0, color: '#ef4444' }

describe('normalizeProjectGroups', () => {
  it('keeps a valid icon and color across a profile reload', () => {
    const [group] = normalizeProjectGroups([{ ...persisted, icon: { type: 'emoji', emoji: '🚀' } }])
    expect(group.icon).toEqual({ type: 'emoji', emoji: '🚀' })
    expect(group.color).toBe('#ef4444')
  })

  it('drops an icon that would not pass the renderer sanitizer', () => {
    const [group] = normalizeProjectGroups([
      { ...persisted, icon: { type: 'image', src: 'http://evil.example/x.png', source: 'favicon' } }
    ])
    expect(group).not.toHaveProperty('icon')
  })
})
