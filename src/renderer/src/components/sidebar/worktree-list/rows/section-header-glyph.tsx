import React from 'react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { RepoMark } from '@/components/repo/RepoMark'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { resolveRepoHeaderColor } from './project-header-color'

/** A header's leading glyph: the project's icon, a group's own icon and color, else the generic glyph. */
export function SectionHeaderGlyph({
  row,
  repoColor,
  isGroupHeader,
  fallback: Fallback
}: {
  row: Pick<GroupHeaderRow, 'repo' | 'projectGroup'>
  repoColor: string | undefined
  isGroupHeader: boolean
  fallback: React.ComponentType<{ className?: string }>
}): React.JSX.Element {
  if (row.repo && repoColor) {
    // Same resolved mark as the workspace cards, so auto colors and clash boxes match.
    return <RepoMark repo={row.repo} size="md" />
  }
  if (row.repo) {
    return (
      <RepoIconGlyph repoIcon={row.repo.repoIcon} className="size-4" iconClassName="size-3.5" />
    )
  }
  const group =
    isGroupHeader && row.projectGroup && 'createdFrom' in row.projectGroup ? row.projectGroup : null
  const color = group?.color ? resolveRepoHeaderColor(group.color) : undefined
  if (group?.icon) {
    return (
      <RepoIconGlyph
        repoIcon={group.icon}
        color={color}
        className="size-4"
        iconClassName="size-3.5"
      />
    )
  }
  return (
    <span className="inline-flex" style={color ? { color } : undefined}>
      <Fallback className="size-3" />
    </span>
  )
}
