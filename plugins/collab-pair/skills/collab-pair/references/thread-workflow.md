# Codex thread workflow

## State model

The local MCP server stores collaboration state in:

`$CODEX_HOME/collab-pair/state.json`

When `CODEX_HOME` is unset, it uses:

`~/.codex/collab-pair/state.json`

The state contains manager settings, project names, worker links and modes, relay configuration, local aliases, pending rounds, structured reports, and bounded history. The MCP server writes atomically. A malformed state file is preserved with a `.corrupt-<timestamp>` suffix before a new state is started.

The `collab_dashboard` tool is an MCP App. Codex fetches its `ui://collab-pair/dashboard.html` resource and renders the task board inline or in the task side panel. The app can link workers, dispatch rounds, configure projects and relay settings, inspect reports, close workers, and unlink pairs through the same MCP tools. No separate browser tab is required.

The optional `collab_open_window` tool starts a native Windows Tkinter window backed by the same state. The MCP process also runs the relay poller and stalled-round reminder loop.

The local HTTP service at `http://127.0.0.1:43157/` remains only as a compatibility fallback for clients that do not support MCP Apps or the native window.

## Exact manager sequence

1. Call `collab_status({ threadId })`.
2. Call `collab_init({ managerThreadId: threadId, managerTitle, goal, projectName, config })` when starting.
3. Call `list_threads` if workers are not already known. Use `create_thread` only when the user explicitly requested a new conversation.
4. Call `collab_link({ currentThreadId, peerThreadId, role: "manager", currentTitle, peerTitle, projectName, mode })` for each worker.
5. Call `collab_dispatch({ managerThreadId, worker, task, acceptance })`.
6. Check `delivery.sent`. When true, the plugin already used `codex queue` or the relay. When false, send the returned `dispatch.messageText` unchanged with `send_message_to_thread`.
7. For a local worker, call `wait_threads` with its thread id.
8. Call `read_thread` to obtain the actual final assistant message.
9. Call `collab_complete_round({ workerThreadId, round, finalOutput, turnReason })`.
10. For a remote worker, the manager plugin records the relayed report and clears the pending round automatically; review the queued manager report instead of waiting on the synthetic `remote:<device>:<alias>` id.
11. Review status, final output, and acceptance criteria. Repeat from step 5 or close with `collab_done`.

## Exact worker sequence

The dispatch message includes `worker_thread_id`, round, task, acceptance criteria, and reporting instructions. Local and remote dispatch messages use the same contract.

Before ending:

```text
collab_report({
  worker_thread_id,
  round,
  status: "done" | "partial" | "blocked",
  summary,
  details,
  next
})
```

Then send the final deliverable or verification summary. Do not call `collab_complete_round`; that belongs to the manager because final local output is read after the worker turn ends. A remote worker's structured report is relayed immediately.

## Existing and new threads

For an existing conversation, use its exact id from `list_threads`. Do not link subagent-origin threads.

For a new conversation, call `create_thread` only when the user explicitly asked for one. Prefer creating it in the same project as the manager so both threads share the working directory. If the manager has no project and the create-thread interface cannot select a directory, ask the user to create the worker in the intended workspace.

A model can be selected only during explicit creation. Do not claim that an existing Codex thread's model or preset was changed; the Codex app tools do not expose that operation.

## Projects and link modes

- A project is the set of workers managed by one manager thread. Rename it with `collab_project` or the visual settings form.
- Temporary links are removed on `collab_done`; the board no longer lists them.
- Permanent links remain visible as done and can be linked or dispatched again later. Use `collab_unlink` to remove one.
- One worker can belong to only one manager at a time.

## Wait and recovery

- `wait_threads` can wait for up to eight targets. Use one worker per wait when step-by-step manager review is required.
- Only wait on real local thread ids. Remote worker ids are routing labels, not Codex thread ids.
- If a worker is still running, continue waiting; do not dispatch another round to that worker.
- If a worker ends without calling `collab_report`, call `collab_complete_round` with `report.status = "partial"` only when the final output clearly justifies it. Otherwise omit the report and let the state show `unreported`.
- If a send fails, do not advance the round. Correct the thread id or authorization and retry.
- If a round is stuck and the user authorizes replacement, call `collab_dispatch` with `force: true`. This is deliberate and should preserve history.

## Title rules

The default prefixes are `【项目经理】` and `【员工】`. Apply them only when `titleUpdates` is non-empty and `currentTitle !== nextTitle`. Strip only known prefixes when closing or unlinking. Do not replace a title the user changed while the collaboration was active unless that exact title still has a configured role prefix.

## Remote relay

1. Configure both devices with the same `hubUrl`, `hubToken`, and `hubRoom`, plus distinct `deviceName` values.
2. Start `hub.mjs` on one reachable machine. Use HTTPS when traffic crosses an untrusted network.
3. On the worker device, register `alias` for the exact local thread id.
4. On the manager device, use `collab_remote({ action: "link", ... })`.
5. `collab_dispatch` sends through the hub. The worker plugin polls, queues the task with `codex queue`, receives `collab_report`, and posts the report back.
6. `collab_done` and `collab_unlink` notify the remote worker. Temporary links disappear from the local board after completion.

## Unattended mode

An active manager turn can wait on worker turns. The MCP server also checks stalled rounds once per minute and queues a reminder using the configured `autoNudge` interval. For progress across separate turns, use a thread heartbeat only when the user asks for it. Notify only when a round completed, failed, or needs a user decision.
