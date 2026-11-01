// A stand-in rendered worker whose answers a test picks by file path. It logs
// its start (pid and TMPDIR) and every job it receives, with when it came. A
// path starting with `answer` is answered at once, one starting with
// `delay-<ms>-` that many milliseconds later; anything else is never
// answered. Layout and tile jobs name their file in their source's fragment.
import fs from 'node:fs';
import path from 'node:path';

const log = path.join(process.env.BRANCH_REVIEW_MEDIA_TMP, 'rendered-scripted.log');
const write = (entry) => fs.appendFileSync(log, `${JSON.stringify({at: Date.now(), pid: process.pid, ...entry})}\n`);
write({event: 'start', tmpdir: process.env.TMPDIR});

const summary = {kind: 'rendered', changes: {changed: 0, removed: 0}, differences: [], blocks: [], headings: [], links: []};

const layout = {heightCss: 100, blocks: [], removed: [], links: [], anchors: []};

const answer = (message, file) => {
  if (message.type === 'page') process.send({id: message.id, ok: true, html: `<p>${file}</p>`, summary});
  else if (message.type === 'layout') process.send({id: message.id, ok: true, layout, document: `doc-${file}`});
  else if (message.type === 'tile') process.send({id: message.id, ok: true, png: []});
  else process.send({id: message.id, ok: true, summary});
};

process.on('message', (message) => {
  const file = message.path ?? message.file?.path ?? message.source?.fragment?.path ?? '';
  write({event: 'job', id: message.id, type: message.type, path: file});
  const delay = /^delay-(\d+)-/.exec(file);
  if (delay) setTimeout(() => answer(message, file), Number(delay[1]));
  else if (file.startsWith('answer')) answer(message, file);
});
process.on('disconnect', () => process.exit(0));
