// The rendered worker: reads markdown and the images it embeds from the
// reviewed repo, renders them and assembles pages for the UI process, over
// IPC. Repo text is untrusted, and the markdown parser can be kept busy for
// minutes by some inputs; here that costs the rendered view a strike instead
// of the terminal. The parent kills this process's group at a job's
// deadline, which also ends any git it started.
import {LOOKUP_BUDGET_MS} from './rendered/assets.js';
import {createRenderedHandler} from './rendered/worker/handler.js';
import type {RenderedWorkerRequest} from './rendered/backend.js';

const send = process.send?.bind(process);
if (!send) {
  throw new Error('renderedWorker must run as a forked child process');
}

const groupKill = process.platform !== 'win32';
// A fragment's deadline is 5 seconds; its images get part of it.
const handler = createRenderedHandler({lookupBudgetMs: LOOKUP_BUDGET_MS});

// The parent is gone: stop the git this process is waiting on and exit.
process.once('disconnect', () => {
  try {
    process.kill(groupKill ? -process.pid : process.pid, 'SIGKILL');
  } catch {
    process.exit(0);
  }
});

process.on('message', (message: {id: number} & RenderedWorkerRequest) => {
  void handler.handle(message).then((result) => {
    if (process.connected) send({id: message.id, ...result});
  });
});
