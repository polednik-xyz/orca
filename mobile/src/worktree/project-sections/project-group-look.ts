import type { ProjectGroup } from '../../../../src/shared/project/groups/project-group-types'
import type { Section } from '../workspace-list/workspace-list-types'

/** The group's own icon and color for its header; the Ungrouped stand-in has neither. */
export function projectGroupLook(
  group: ProjectGroup | { id: null }
): Pick<Section, 'projectGroupIcon' | 'projectGroupColor'> {
  if (!('createdFrom' in group)) {
    return {}
  }
  return {
    ...(group.icon ? { projectGroupIcon: group.icon } : {}),
    ...(group.color ? { projectGroupColor: group.color } : {})
  }
}
