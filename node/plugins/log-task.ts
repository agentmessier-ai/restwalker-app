import type { Plugin } from '../plugins.js'

export const logTaskPlugin: Plugin = {
  name: 'log-task',
  register(ctx) {
    ctx.on('pre_task', ({ task }) => {
      // already logged by runner — this is just a demo hook
    })
    ctx.on('post_task', ({ task, status, tokensUsed }) => {
      // no-op — runner already logs this; shows the hook shape
    })
  },
}
