# Project group icon and color

- Groups store `icon` (same `RepoIcon` shape as projects: lucide, emoji, uploaded PNG, favicon) and the existing `color` badge field. Set from the group header menu → "Icon and color…".
- Groups have no GitHub remote, so the picker hides "Use GitHub avatar".
- The icon is sanitized with `sanitizeRepoIcon` on load, on update (IPC and runtime RPC) and when read from a host's sidebar feed; invalid icons fall back to the folder-tree glyph.
- Phones get lucide, emoji and https image icons. Uploaded data-URL images are stripped from the phone feed (size), so the phone shows the folder glyph for those.
- An older remote host strips the unknown `icon` key; the renderer treats that as a failed update and shows a toast instead of pretending it saved.
