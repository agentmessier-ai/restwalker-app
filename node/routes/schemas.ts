// Shared OpenAPI/JSON-Schema shapes used across route files

export const S = {
  provider: {
    type: 'object',
    properties: {
      id:           { type: 'integer' },
      name:         { type: 'string' },
      command:      { type: 'string' },
      args_template:{ type: 'string' },
      is_default:   { type: 'integer' },
      loop_type:    { type: 'string', enum: ['claude_print', 'claude_sdk'] },
      created_at:   { type: 'string', format: 'date-time' },
    },
  },
  task: {
    type: 'object',
    properties: {
      id:           { type: 'integer' },
      origin_id:    { type: 'integer', nullable: true },
      description:  { type: 'string' },
      cwd:          { type: 'string' },
      model:        { type: 'string' },
      provider_id:  { type: 'integer', nullable: true },
      schedule:     { type: 'string', enum: ['once','hourly','daily','weekly','monthly'] },
      next_run_at:  { type: 'string', nullable: true },
      status:       { type: 'string', enum: ['scheduled','pending','running','done','failed','cancelled'] },
      result:         { type: 'string', nullable: true },
      workspace_path: { type: 'string', nullable: true },
      session_id:     { type: 'string', nullable: true },
      session_path:   { type: 'string', nullable: true },
      tool_calls:   { type: 'integer' },
      tokens_used:  { type: 'integer' },
      created_at:   { type: 'string', format: 'date-time' },
      started_at:   { type: 'string', nullable: true },
      finished_at:  { type: 'string', nullable: true },
      prompt_id:    { type: 'integer', nullable: true },
      webhook_pre_url:    { type: 'string', nullable: true },
      webhook_post_url:   { type: 'string', nullable: true },
      webhook_timeout_s:  { type: 'integer' },
      webhook_retry:      { type: 'integer' },
      webhook_ignore_ssl: { type: 'integer' },
      timeout_s:          { type: 'integer', nullable: true },
      tags:               { type: 'string', nullable: true },
    },
  },
  ok: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
  },
  error: {
    type: 'object',
    properties: { error: { type: 'string' } },
  },
} as const

export const S_PROMPT = {
  type: 'object',
  properties: {
    id:         { type: 'integer' },
    version:    { type: 'integer' },
    label:      { type: 'string' },
    content:    { type: 'string' },
    is_builtin: { type: 'integer' },
    created_at: { type: 'string' },
  },
} as const

export const S_TASK_PROMPT = {
  type: 'object',
  properties: {
    id:          { type: 'integer' },
    origin_id:   { type: 'integer' },
    version:     { type: 'integer' },
    title:       { type: 'string' },
    content:     { type: 'string' },
    cwd:         { type: 'string' },
    model:       { type: 'string' },
    provider_id: { type: 'integer', nullable: true },
    schedule:    { type: 'string' },
    created_at:  { type: 'string' },
  },
} as const
