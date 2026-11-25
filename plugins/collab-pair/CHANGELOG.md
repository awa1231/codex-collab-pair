# Changelog

## 1.4.0

- Added an integrated Codex MCP App task board rendered inline or in the task side panel.
- Added `collab_dashboard` MCP App metadata and the `ui://collab-pair/dashboard.html` resource.
- Added an app-only `collab_app_state` refresh tool.
- Moved project, dispatch, link, relay, settings, close, and unlink actions into the integrated app.
- Kept the native Windows window as an optional entry and the local HTTP page as a compatibility fallback.

## 1.3.0

- Added project names and grouped board data.
- Added temporary and permanent link modes.
- Changed `maxRounds: 0` to mean unlimited.
- Added automatic local delivery through `codex queue`.
- Added cross-device relay configuration, aliases, dispatch, report, done, and unlink messages.
- Added the in-memory `hub.mjs` relay.
- Added stalled-round background reminders.
- Added native and web settings for projects, link mode, unlimited rounds, and automatic delivery.
- Expanded the self-test with a real relay round trip.
