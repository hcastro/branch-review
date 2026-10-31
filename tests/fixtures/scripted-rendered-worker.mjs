// A stand-in rendered worker whose answers a test picks by file path. It logs
// its start (pid and TMPDIR) and every job it receives. A path starting with
// `answer` is answered at once; anything else is never answered.
import fs from 'node:fs';
import path from 'node:path';

const log = path.join(process.env.BRANCH_REVIEW_MEDIA_TMP, 'rendered-scripted.log');
const write = (entry) => fs.appendFileSync(log, `${JSON.stringify({at: Date.now(), pid: process.pid, ...entry})}\n`);
write({event: 'start', tmpdir: process.env.TMPDIR});

const summary = {kind: 'rendered', changes: {changed: 0, removed: 0}, differences: [], blocks: [], headings: [], links: []};

process.on('message', (message) => {
  const file = message.path ?? message.file?.path ?? '';
  write({event: 'job', id: message.id, type: message.type, path: file});
  if (!file.startsWith('answer')) return;
  if (message.type === 'page') process.send({id: message.id, ok: true, html: `<p>${file}</p>`, summary});
  else process.send({id: message.id, ok: true, summary});
});
process.on('disconnect', () => process.exit(0));
