// The media worker: reads, verifies, sniffs and decodes image bytes from the
// reviewed repo for the UI process, over IPC. Repo bytes are untrusted, and
// the image library is native code; here a crash or a hang costs one preview
// instead of the terminal. The parent kills this process's group at a job's
// deadline, which also ends any git it started.
import {createWorkerHandler} from './media/worker/handler.js';
import type {WorkerRequest} from './media/backend.js';

const send = process.send?.bind(process);
if (!send) {
  throw new Error('mediaWorker must run as a forked child process');
}

const groupKill = process.platform !== 'win32';
const handler = createWorkerHandler();

// The parent is gone: stop the git this process is waiting on and exit.
process.once('disconnect', () => {
  try {
    process.kill(groupKill ? -process.pid : process.pid, 'SIGKILL');
  } catch {
    process.exit(0);
  }
});

process.on('message', (message: {id: number} & WorkerRequest) => {
  void handler.handle(message).then((result) => {
    if (process.connected) send({id: message.id, ...result});
  });
});
