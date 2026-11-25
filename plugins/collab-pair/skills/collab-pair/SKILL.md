---
name: collab-pair
description: Coordinate one Codex project-manager thread with local or remote worker threads through automatic dispatch, structured reports, project grouping, review, and repeated rounds. Use when the user wants to link Codex conversations, run a multi-round manager-worker project, or monitor a collaboration task board.
metadata:
  short-description: Coordinate manager and worker Codex threads
---

# Collab Pair

Use the `collab_pair` MCP tools to persist role links and task state, and Codex thread tools to list, create, and observe conversations. The manager owns the project goal, task breakdown, and acceptance criteria. Workers execute one dispatched round at a time and report honestly.

The plugin supports projects, multiple workers per manager, temporary/permanent links, automatic local delivery through `codex queue`, and cross-device delivery through the bundled relay hub.

## Identify the current role

1. Get the current thread id with `node <skill-dir>/scripts/thread-context.mjs`.
2. Call `collab_status` with that id.
3. If status is unlinked and the user wants to start, call `collab_init` with the current id, title, goal, and language.

Never infer the current thread id from a title alone. Use the environment id printed by the helper.

## Manager workflow

- Use `list_threads` to find existing worker threads. Use `create_thread` only when the user explicitly asks for a new worker thread. Codex model choices can be set only during explicit thread creation; there is no supported tool for changing an existing thread's model.
- Link workers with `collab_link`. Supply exact thread ids, current titles, a project name, and `mode: "temporary" | "permanent"`. Temporary links unbind on `collab_done`; permanent links stay until `collab_unlink`.
- Immediately before the first message to each thread, confirm that the user explicitly authorized messaging that thread. Their request to run or continue the collaboration normally provides that authorization.
- For each round, call `collab_dispatch` first. It rejects duplicate pending rounds and returns the exact `dispatch.messageText`.
- `collab_dispatch` attempts automatic delivery by default. If `delivery.sent` is true, do not send the prompt again. If delivery failed, send `dispatch.messageText` with `send_message_to_thread` or set `send: false` for manual delivery.
- Use `wait_threads` to wait for the worker to finish. Do not mark a round complete before the worker has ended its turn.
- Read the worker result with `read_thread`, then call `collab_complete_round` with the final text and turn reason. Review the returned manager-facing report before deciding the next round.
- Continue while acceptance criteria are unmet. Call `collab_done` only after the user or manager has verified the outcome.
- Rename a project with `collab_project`; every worker managed by that thread follows the same project name.

## Worker workflow

When a message starts with `【协作任务` or `[Collaboration task`, treat it as a worker assignment:

1. Follow the latest task and acceptance criteria without expanding scope.
2. Before ending the turn, call `collab_report` with `worker_thread_id`, `status`, `summary`, `details`, and `next`.
3. Make the final assistant response a concise deliverable or verification summary. The manager will read that final output and record it with `collab_complete_round`.
4. Do not dispatch to other workers. Do not call `collab_done`; only the manager closes a worker.

Use `done` only when the round is complete and verified, `partial` when useful work remains, and `blocked` when a decision or missing input prevents progress.

For a remote dispatch, the same rule applies; use the `worker_thread_id` included in the remote task.

## Status and board

- `collab_status` answers “what am I in this collaboration?”
- `collab_board` returns all tasks, active first, plus project groups. Render it as a compact Markdown table when the user asks for the board.
- A pending round is `等待回报`; an active worker with no pending round is `空闲`; a closed link is `已结束`.

## Integrated Codex app

When the user asks for the visual interface, the task board, or settings, call `collab_dashboard`. It is an MCP App tool: Codex renders the task board inline or in the task side panel, with no separate browser tab required.

The MCP App supports viewing projects and tasks, linking workers, dispatching rounds, copying a fallback prompt, project and runtime settings, cross-device relay setup, closing a worker, unlinking, and opening the optional native window. It uses the same persisted state as the MCP tools.

Use `collab_open_window` only when the user explicitly wants a separate native Windows window. For text-only hosts that do not support MCP Apps, the older local dashboard URL remains available as a fallback.

## Cross-device collaboration

Configure both devices with `collab_remote({ action: "configure", hubUrl, hubToken, hubRoom, deviceName })`.

- On the worker device, register one local conversation as `collab_remote({ action: "alias", alias, session, currentTitle })`.
- On the manager device, link it with `collab_remote({ action: "link", managerThreadId, device, worker: alias, name, mode })`.
- Dispatch normally. The manager sends through the relay; the worker plugin queues the task into its local Codex thread and sends the structured report back.
- The manager plugin records a remote report automatically and queues the manager conversation. Do not wait for a synthetic remote thread id with `wait_threads`.
- Run `node hub.mjs --port 8787 --token <long-random-secret>` on one machine or small VPS. Put it behind HTTPS before using it across untrusted networks. The hub keeps messages in memory for 15 minutes.
- Use `collab_remote({ action: "status" | "aliases" })` to inspect the relay and aliases.

## Titles and cleanup

When a result contains `titleUpdates` and title prefixes are enabled, read the current title and apply each update with `set_thread_title`. On unlink or close, remove only the configured manager/worker prefixes and leave the rest of each title intact. Do not append or remove prefixes again when `currentTitle === nextTitle`.

## Unattended progress

`wait_threads` keeps a manager turn alive while workers run. For progress across separate turns, use `collab_due` only when the user asks for unattended monitoring; configure a thread heartbeat with `automation_update` rather than polling in a loop. A heartbeat should notify only on completion, failure, or required user action.

Read [references/thread-workflow.md](references/thread-workflow.md) for detailed sequencing, title handling, and recovery rules.
