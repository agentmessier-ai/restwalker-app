# restwalker Plugin Specification

version 0.1

---

## Overview

A restwalker plugin is a JS/TS file that registers handlers on lifecycle hooks. The host fires hooks at the right moment; the plugin decides what to do.

---

## Design principle: API-first

restwalker is built API-first. Every capability is defined once at the API/declaration layer, and every other surface — UI form, REST endpoint, MCP tool — is *derived* from it. You never hand-write the same field twice.

This shows up in two places that matter to plugin authors:

1. **Host task fields flow API → UI → MCP automatically.** A task field (e.g. `webhook_pre_url`) is declared once in its Fastify route schema. The OpenAPI spec at `/docs/json` is the single source of truth; the web form reads it, and the MCP `queue_add` tool derives its input schema from it at startup. Add a field to the route and it appears in all three surfaces with no further edits.

2. **A plugin's `settings` declaration is itself the single source.** You declare each field once in `settings`. From that one declaration the host derives:
   - the **form** rendered in the Plugins panel (input type inferred from the default's type),
   - the **persisted shape** in `~/.restwalker/plugins.json`,
   - the **config object** passed into `register(ctx, config)`,
   - the **`POST /plugins/:name/config`** request body.

So when you write a plugin, declare capability and config *once* in the plugin object. Do not build your own form, your own storage schema, and your own config parser — the host derives all of them from your declaration. If you find yourself writing a field name more than once, you're fighting the grain.

---

## Plugin shape

```typescript
export default {
  name: 'my-plugin',          // unique, kebab-case

  // Optional — declares fields the host will render as a settings form
  settings: {
    webhookUrl: { label: 'Webhook URL', default: '' },
    channel:    { label: 'Channel',     default: '#general' },
    onFailure:  { label: 'Failure only', default: false },
  },

  // config is populated from stored values (falling back to defaults)
  register(ctx, config) {
    ctx.on('post_task', ({ task, status }) => {
      if (config.onFailure && status !== 'failed') return
      // config.webhookUrl, config.channel, ...
    })
  }
}
```

No framework. If your plugin has no configurable fields, omit `settings` and leave the second arg unused.

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

## Settings

Declare a `settings` object to get a form rendered automatically in the Plugins panel:

```typescript
settings: {
  webhookUrl: { label: 'Webhook URL',   default: '',      sensitive: true,  placeholder: 'https://...' },
  channel:    { label: 'Channel',       default: '#ops'                                                },
  onFailure:  { label: 'Failure only',  default: false                                                 },
  maxRetries: { label: 'Max retries',   default: 3                                                     },
}
```

| Default type | Rendered as          |
|--------------|----------------------|
| `string`     | Text input           |
| `boolean`    | Toggle checkbox      |
| `number`     | Number input         |

`sensitive: true` masks the text input. `placeholder` adds hint text.

Values are stored in `~/.restwalker/plugins.json` and passed as the second argument to `register()`. The host merges stored values with defaults at load time — new fields in `settings` appear with their default until the user saves.

This `settings` block is the **single source** for the whole config surface (see [Design principle: API-first](#design-principle-api-first)). The form, the storage, the `config` argument, and the config endpoint all derive from it:

```
settings declaration ──┬──▶ Plugins-panel form
                       ├──▶ ~/.restwalker/plugins.json
                       ├──▶ register(ctx, config)
                       └──▶ POST /plugins/:name/config
```

Via API: `POST /plugins/:name/config` with `{ key: value }` (partial updates are fine). The accepted keys are exactly the keys you declared in `settings` — nothing to register separately.

---

## Example — post to Slack on task completion

```typescript
export default {
  name: 'slack-notify',

  settings: {
    webhookUrl: { label: 'Webhook URL', default: '', sensitive: true },
    onFailure:  { label: 'Failure only', default: false },
  },

  register(ctx, config) {
    ctx.on('post_task', async ({ task, status }) => {
      const url = config.webhookUrl as string
      if (!url) return
      if (config.onFailure && status !== 'failed') return
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

Storage, caching, or any other concerns beyond config are the plugin's own responsibility.

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
3. Merge stored config values with `settings` defaults
4. Call `register(ctx, config)` to wire the handlers
5. Show the plugin in the Plugins panel with its registered hooks and settings form

---

## Rules

- `register()` is called once at load time — do not put async work that can fail here
- Hook handlers run in registration order across all enabled plugins
- A handler throwing does not block other plugins — errors are logged and swallowed
- Handlers may be async; the host awaits each one before the next fires
