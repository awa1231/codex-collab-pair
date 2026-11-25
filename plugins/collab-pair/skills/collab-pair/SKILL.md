---
name: collab-pair
description: Make a Codex conversation a project manager, create worker conversations, delegate tasks, and keep a simple saved todo list. Use when the user asks to set a manager, create workers, split work across conversations, or manage a short list of delegated tasks.
metadata:
  short-description: Manager and worker conversations with a simple todo list
---

# Collab Pair

Keep this plugin small. It uses Codex's built-in conversation tools and one tiny todo-state script.

## Language

- Use **English by default** for role prefixes, generated prompts, status, and todo summaries.
- Switch to Chinese only when the user explicitly says to use Chinese or asks for the Chinese version.
- English role prefixes: `[Project Manager]`, `[Employee]`.
- Chinese role prefixes: `【项目经理】`, `【员工】`.

## Core rules

- The current conversation becomes a project manager when its title is prefixed with `[Project Manager]`.
- A manager-created worker title is prefixed with `[Employee]`.
- Create conversations only when the user explicitly asks for a worker.
- The manager owns the goal, task split, worker creation, acceptance, and final response.
- Workers execute one assigned task and return a concise result.

## Identify the conversation

Run:

```bash
node <skill-dir>/scripts/thread-context.mjs
```

Use the printed `threadId`, then call `list_threads` to obtain the exact current title and project metadata.

## Set as project manager

When the user asks to make this conversation a manager:

1. Get the exact current thread id and metadata.
2. Remove any known role prefix from the title.
3. Rename it to `[Project Manager] <title>` by default.
4. Confirm in one short sentence.

Do not create a worker during this step.

## Create a worker

When the user explicitly asks the manager to create a worker:

1. Call `create_thread`.
2. Use the manager's project/environment when possible.
3. Set the title to `[Employee] <name>`.
4. Pass a short placeholder prompt to `create_thread`; the real task is queued in the next step:

```text
Wait for the project manager's queued task.
```

5. Queue the real task with `dispatch.mjs`, trigger it, wait, and read the result.
6. Return the employee title, thread id, and verified result.

Create one worker per explicitly requested role.

### Important delivery rule

In current Codex desktop builds, `create_thread.prompt` and `send_message_to_thread` may appear to the recipient as internal delegation output instead of a normal user task. Deliver the task through the queue script:

```bash
node <skill-dir>/scripts/dispatch.mjs --thread <employeeThreadId> --message "<task prompt>"
```

Then call `send_message_to_thread` with the employee id and the short trigger:

```text
Continue with the queued user task now.
```

The trigger starts a turn; the queued message is what the employee executes. Always call `wait_threads`, then `read_thread`, and verify the actual final result.

## Delegate a task

For an existing worker, prepare a task containing:

```text
Manager task:
<task>

Scope:
<limits>

Acceptance:
<criteria>

Return a concise deliverable and verification summary.
```

Queue it with `dispatch.mjs`, trigger it with `send_message_to_thread`, then call `wait_threads` and `read_thread`. Review the actual result.

## Simple todo list

Any conversation can keep a persistent todo list. Use the exact thread id.

Add an item:

```bash
node <skill-dir>/scripts/todo.mjs --action add --thread <threadId> --title "Short title" --prompt "Prompt to execute"
```

List items:

```bash
node <skill-dir>/scripts/todo.mjs --action list --thread <threadId>
```

Get the next item:

```bash
node <skill-dir>/scripts/todo.mjs --action next --thread <threadId>
```

Mark the active item done:

```bash
node <skill-dir>/scripts/todo.mjs --action done --thread <threadId>
```

Remove or clear:

```bash
node <skill-dir>/scripts/todo.mjs --action remove --thread <threadId> --id <itemId>
node <skill-dir>/scripts/todo.mjs --action clear --thread <threadId> --scope pending
```

When the user says **start/run the todo list**:

1. Call `next`.
2. Execute the returned prompt in the current turn, or assign it to an existing worker when appropriate.
3. Call `done`.
4. Repeat until `next` returns no pending item.
5. Finish with a compact checklist summary.

The todo list is intentionally a simple saved checklist. Do not claim that a background process scans or sends todos after this turn ends.

## Worker behavior

A worker conversation should:

1. Execute only the assigned task.
2. Avoid changing the manager's direction.
3. Finish with a concise summary of changes, evidence, and verification.
4. Never create another worker.

## Safety and recovery

- Never infer a thread id from its title.
- Do not create replacement workers after a send failure; retry the correct thread id.
- Wait for a running worker instead of issuing a duplicate task.
- Do not archive or delete a worker without user confirmation.
