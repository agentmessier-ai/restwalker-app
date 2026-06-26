import type { Plugin } from '../plugins.js'
import * as gbrain from '../gbrain.js'

export const gbrainPlugin: Plugin = {
  name: 'gbrain',
  register(ctx, _config) {
    ctx.on('post_task', async ({ task, workspacePath, status, result }) => {
      if (status !== 'done') return
      await gbrain.storeTaskResult(task.id, task.description, result, workspacePath)
    })
  },
}
