# Changelog

## 2.0.0

- Simplified the plugin to a skill-only workflow.
- Removed the MCP server, task board, native window, relay hub, cross-device support, project settings, persistent state, and web UI.
- Added a direct workflow for setting the current conversation as a project manager.
- The manager can now create worker conversations with Codex's built-in `create_thread` tool.
- The manager delegates through `send_message_to_thread` and reviews results with `wait_threads` and `read_thread`.

## 1.4.0

- Integrated MCP App task board and cross-device collaboration features.
