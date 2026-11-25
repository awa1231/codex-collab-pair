---
name: collab-pair
description: Turn a Codex conversation into a project manager that can create worker conversations and delegate tasks. Use when the user asks to make the current conversation a project manager, create workers for it, or have that manager assign tasks across conversations.
metadata:
  short-description: Make a conversation manage worker conversations
---

# Collab Pair

Keep this workflow small. Use only Codex's built-in conversation tools; this plugin has no task board, database, or background server.

## Roles

- A project manager is the current conversation after its title is prefixed with `【项目经理】`.
- A worker is a conversation created by the manager with a title prefixed by `【员工】`.
- The user remains in control of whether new conversations are created.

## Identify the current conversation

Run:

```bash
node <skill-dir>/scripts/thread-context.mjs
```

Use the printed `threadId`. Then call `list_threads` and find the exact conversation. Never infer the id from a title.

## Make the current conversation a project manager

When the user says to make this conversation a project manager:

1. Get the current thread id and metadata with the helper and `list_threads`.
2. Remove an existing `【项目经理】` or `【员工】` prefix from the current title.
3. Call `set_thread_title` and prefix the title with `【项目经理】`.
4. Confirm briefly that this conversation is now the manager.

Do not create a worker during this step. Creating conversations requires a later explicit user request such as “创建一个员工” or “把这个任务交给员工”.

Example:

```text
原标题：修复登录流程
新标题：【项目经理】修复登录流程
```

## Create a worker

When the user explicitly asks the project manager to create a worker:

1. Confirm that the current conversation is the manager.
2. Call `create_thread`.
3. Use the same project/environment as the manager when possible.
4. Set the new title to `【员工】<worker name>`.
5. Give the new conversation a short prompt:

```text
你是项目经理创建的员工对话。

本轮任务：
<task>

验收标准：
<acceptance, if provided>

直接执行任务，不要扩大范围。结束时给出简洁的交付说明、修改内容和验证结果。
```

6. Return the new conversation title and id to the user.

Create one worker per explicitly requested role. If the user asks for three workers, create three separate conversations. Do not create workers speculatively.

If `create_thread` cannot select a working directory or project, ask the user to create the worker from the intended workspace; do not guess.

## Assign another task

When a worker already exists, use `send_message_to_thread` with its exact thread id. Include:

- the task;
- scope limits;
- acceptance criteria;
- a request for a concise final deliverable and verification summary.

Then call `wait_threads` for that worker and use `read_thread` to obtain its final answer.

When several workers are running independently, wait for up to eight using `wait_threads`, then read each completed result.

## Worker behavior

A worker conversation should:

1. Execute only the assigned task.
2. Avoid changing the manager's overall direction.
3. Finish with a concise summary containing changes, evidence, and verification.
4. Return control to the manager after the result.

Workers do not create more workers.

## Manager behavior

The manager owns:

- the goal;
- task breakdown;
- acceptance criteria;
- worker creation;
- review of worker results;
- the final answer to the user.

Do not do a worker's delivery task in parallel unless the user explicitly asks the manager to contribute directly.

## Recovery

- If a conversation title prefix was removed, use its known thread id rather than guessing.
- If a worker turn is still running, wait instead of sending a duplicate task.
- If sending fails, do not create a replacement worker automatically; report the error and retry with the correct thread id.
- If a worker is no longer needed, ask before archiving or deleting it.
