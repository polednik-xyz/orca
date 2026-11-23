import React from 'react'
import { toast } from 'sonner'
import { FolderTree, RotateCcw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { RepositoryIconColorSection } from '@/components/settings/repository/identity/RepositoryIconColorSection'
import { RepositoryIconTabs } from '@/components/settings/repository/identity/RepositoryIconTabs'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type {
  ProjectGroup,
  ProjectGroupUpdate
} from '../../../../../../shared/project/groups/project-group-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { resolveRepoHeaderColor } from './project-header-color'

export type ProjectGroupAppearanceDialogState = { groupId: string; hostId?: ExecutionHostId }

export function ProjectGroupAppearanceDialog({
  target,
  projectGroups,
  onOpenChange
}: {
  target: ProjectGroupAppearanceDialogState | null
  projectGroups: readonly ProjectGroup[]
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  // Why: read the live group so each pick shows at once and same-id groups on other hosts stay apart.
  const group = target
    ? projectGroups.find(
        (candidate) =>
          candidate.id === target.groupId &&
          (target.hostId === undefined || getRepoExecutionHostId(candidate) === target.hostId)
      )
    : undefined

  const apply = (updates: ProjectGroupUpdate): void => {
    if (!target) {
      return
    }
    void updateProjectGroup(target.groupId, updates, { hostId: target.hostId }).then((saved) => {
      if (!saved) {
        toast.error(
          t('auto.components.sidebar.WorktreeList.groupAppearanceFailed', 'Failed to update group')
        )
      }
    })
  }

  const icon = group?.icon ?? null
  const color = group?.color ? resolveRepoHeaderColor(group.color) : undefined
  return (
    <Dialog open={target !== null && group !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.sidebar.WorktreeList.customizeGroupTitle', 'Customize Group')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.sidebar.WorktreeList.customizeGroupDesc',
              'Pick the icon and color shown for {{name}} in the sidebar.',
              { name: group?.name ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        {group ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span
                className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30"
                style={color ? { color } : undefined}
              >
                {icon ? (
                  <RepoIconGlyph
                    repoIcon={icon}
                    color={color}
                    className="size-5"
                    iconClassName="size-5"
                  />
                ) : (
                  <FolderTree className="size-5" />
                )}
              </span>
              <div className="min-w-0 flex-1 truncate text-sm font-semibold">{group.name}</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={!icon && !group.color}
                onClick={() => apply({ icon: null, color: null })}
              >
                <RotateCcw className="size-3.5" />
                {t('auto.components.settings.RepositoryIconPicker.549d126081', 'Reset')}
              </Button>
            </div>
            <RepositoryIconColorSection
              badgeColor={group.color}
              onBadgeColorChange={(color) => apply({ color })}
            />
            <RepositoryIconTabs
              initialTab={
                icon?.type === 'emoji' ? 'emoji' : icon?.type === 'image' ? 'avatar' : 'icon'
              }
              selectedLucideName={icon?.type === 'lucide' ? icon.name : null}
              selectedEmoji={icon?.type === 'emoji' ? icon.emoji : ''}
              onSetIcon={(next) => apply({ icon: next })}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
