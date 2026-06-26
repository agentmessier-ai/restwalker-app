# restwalker Plugin Specification

version 0.1

---

## Overview

A restwalker plugin is a JS/TS file that registers handlers on lifecycle hooks. The host fires hooks at the right moment; the plugin decides what to do.

---

## Plugin shape

```typescript
export default {
  name: 'my-plugin',          // unique, kebab-case
  register(ctx) {
    ctx.on('post_task', ({ task, status, tokensUsed }) => {
      // ...
    })
  }
}
```

That's the whole interface. No framework, no declarations.

---

## Hooks

| Hook            | When it fires                                      |
|-----------------|----------------------------------------------------|
| `pre_task`      | Before the agent starts on a task                  |
| `post_task`     | After the agent finishes (success or failure)       |
| `on_artifact`   | When the agent declares an output file             |
| `on_idle`       | When the queue goes idle                           |
| `on_turn`       | Start of each agent turn (multi-turn sessions)     |
| `on_tool_call`  | Agent is about to call a tool                      |
| `on_tool_result`| Tool has returned its result                       |
| `on_message`    | Agent emits a text message                         |

---

## Hook contexts

```typescript
// pre_task
{ task: Task; workspacePath: string }

// post_task
{ task: Task; workspacePath: string; status: 'done' | 'failed'
  tokensUsed: number; toolCalls: number; result: string }

// on_artifact
{ task: Task; artifactPath: string; description: string; mimeType: string }

// on_idle
{ reason: string }

// on_turn
{ task: Task; turn: number; inputTokens: number }

// on_tool_call
{ task: Task; tool: string; input: Record<string, unknown>; callId: string }

// on_tool_result
{ task: Task; tool: string; callId: string; result: string; isError: boolean }

// on_message
{ task: Task; content: string; thinking?: string }
```

---

## Example — post to Slack on task completion

```typescript
export default {
  name: 'slack-notify',
  register(ctx) {
    ctx.on('post_task', async ({ task, status }) => {
      const url = process.env.SLACK_WEBHOOK_URL
      if (!url) return
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Task #${task.id} ${status}: ${task.description.slice(0, 80)}`
        }),
      })
    })
  }
}
```

Config, storage, and any other concerns are the plugin's own responsibility.

---

## Installation

Drop a `.js` file anywhere and load it via the Plugins panel or REST API:

```
POST /plugins/install
{ "path": "/path/to/my-plugin.js" }
```

The host will:
1. Import the file
2. Validate it exports `{ name, register }`
3. Call `register(ctx)` to wire the handlers
4. Show the plugin in the Plugins panel with its registered hooks

---

## Rules

- `register()` is called once at load time — do not put async work that can fail here
- Hook handlers run in registration order across all enabled plugins
- A handler throwing does not block other plugins — errors are logged and swallowed
- Handlers may be async; the host awaits each one before the next fires
