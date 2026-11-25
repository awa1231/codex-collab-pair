# Changelog

## 2.1.1

- Removed runtime working-directory and platform output from the thread context helper.
- Added a `CODEX_SESSION_ID` fallback for machines where `CODEX_THREAD_ID` is unavailable.
- Removed local state paths from todo command output.
- Documented Windows, macOS, Linux, `CODEX_HOME`, PATH, and `CODEX_CLI_PATH` portability requirements.

## 2.1.0

- Added English manager and employee prompts and title prefixes.
- Made English the default language, with optional Chinese mode.
- Added a persistent per-conversation todo list.
- Added `scripts/todo.mjs` with add, list, next, done, remove, and clear actions.

## 2.0.0

- Simplified the plugin to a skill-only workflow.
- Removed the MCP server, task board, native window, relay hub, cross-device support, project settings, persistent state, and web UI.
- Added a direct workflow for setting the current conversation as a project manager.
- The manager can now create worker conversations with Codex's built-in `create_thread` tool.
- The manager delegates through `send_message_to_thread` and reviews results with `wait_threads` and `read_thread`.

## 1.4.0

- Integrated MCP App task board and cross-device collaboration features.
