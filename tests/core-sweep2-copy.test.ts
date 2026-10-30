import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {getReviewFileContents, resolveRefs} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {buildBlockPromptPayload} from '../src/clipboard/payloads.js';
import {executeCopyCommand} from '../src/commands/execute.js';
import type {CommandContext} from '../src/commands/registry.js';
import type {ReviewBlock, ReviewFile, ReviewModel} from '../src/review/model.js';
import {cleanupTempDirs, initRepo} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 30_000});

afterEach(cleanupTempDirs);

function recordingWriter() {
  const writes: string[] = [];
  return {
    writes,
    write: (text: string) => {
      writes.push(text);
      return {ok: true as const, command: {command: 'fake', args: [], displayName: 'fake'}};
    },
  };
}

function contextFor(model: ReviewModel, filePath: string, cwd: string, range: Parameters<typeof getReviewFileContents>[1]): CommandContext {
  const file = model.files.find((entry) => entry.path === filePath)!;
  return {
    model,
    activeFile: file,
    focusedBlock: file.blocks[0],
    readFileContent: (target) => getReviewFileContents(cwd, range, target),
  };
}

describe('copy actions on a file whose diff failed to load', () => {
  it('fail with the load error', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a2\n');
    fs.writeFileSync(path.join(cwd, 'locked.txt'), 'secret\n');
    fs.chmodSync(path.join(cwd, 'locked.txt'), 0o000);

    try {
      const range = resolveRefs(cwd, 'HEAD', 'main');
      const model = buildReviewModel({cwd, range, width: 100});
      const locked = model.files.find((file) => file.path === 'locked.txt')!;
      expect(locked.error).toBeTruthy();
      const reason = locked.error!;

      const writer = recordingWriter();
      const context = contextFor(model, 'locked.txt', cwd, range);
      for (const id of ['copy.fileDiff']) {
        const result = await executeCopyCommand(id, context, {write: writer.write});
        expect(result).toMatchObject({ok: false, commandId: id, hint: reason});
      }
      expect(writer.writes).toEqual([]);
    } finally {
      fs.chmodSync(path.join(cwd, 'locked.txt'), 0o644);
    }
  });
});

describe('copy actions on non-UTF-8 files', () => {
  it('refuse file contents, file diff and block copies with "not UTF-8 text"', async () => {
    const cwd = initRepo({'latin.txt': 'plain\n', 'utf.txt': 'plain\n'});
    fs.writeFileSync(path.join(cwd, 'latin.txt'), Buffer.from('plain\ncaf\xe9\n', 'latin1'));
    fs.writeFileSync(path.join(cwd, 'utf.txt'), 'plain\ncafé\n');
    const range = resolveRefs(cwd, 'HEAD', 'main');
    const model = buildReviewModel({cwd, range, width: 100});

    const writer = recordingWriter();
    const latin = contextFor(model, 'latin.txt', cwd, range);
    for (const id of ['copy.fileContents', 'copy.fileDiff', 'copy.blockCode', 'copy.blockDiff', 'copy.blockPrompt']) {
      const result = await executeCopyCommand(id, latin, {write: writer.write});
      expect(result.ok, id).toBe(false);
      expect((result as {hint?: string}).hint, id).toMatch(/not UTF-8 text/);
    }
    expect(writer.writes).toEqual([]);

    const utf = contextFor(model, 'utf.txt', cwd, range);
    for (const id of ['copy.fileContents', 'copy.fileDiff', 'copy.blockCode', 'copy.blockDiff', 'copy.blockPrompt']) {
      const result = await executeCopyCommand(id, utf, {write: writer.write});
      expect(result.ok, id).toBe(true);
    }
    expect(writer.writes[0]).toBe('plain\ncafé\n');
    expect(writer.writes.join('\n')).not.toContain('\uFFFD');
  });
});

const block: ReviewBlock = {
  id: 'f:1:0',
  filePath: 'f',
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  lineStart: 1,
  lineEnd: 1,
  rawDiff: '@@ -1 +1 @@\n-```\n+````\n',
  addedCode: '````',
};

function fileWith(filePath: string, rawDiff: string): ReviewFile {
  return {
    path: filePath,
    status: 'modified',
    metrics: {path: filePath, additions: 1, deletions: 1, changedLines: 2},
    rawDiff,
    renderedLines: [],
    blocks: [{...block, filePath, rawDiff: rawDiff.slice(rawDiff.indexOf('@@'))}],
  };
}

// The body of the first fenced block, the way a CommonMark reader closes it:
// at the first line that is a run of at least as many backticks, indented by
// at most three spaces.
function firstFence(text: string) {
  const open = text.match(/^(`{3,})diff\n/m)!;
  const start = open.index! + open[0].length;
  const rest = text.slice(start);
  const close = new RegExp(`^ {0,3}${open[1]}\`*[ \\t]*$`, 'm').exec(rest);
  return close ? rest.slice(0, close.index) : null;
}

describe('agent payload fences and headings', () => {
  it('uses a fence longer than any backtick run in the content', () => {
    const rawDiff = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n ````\n-```\n+`````x\n';
    const file = fileWith('f', rawDiff);

    const cases: Array<[string, string]> = [
      [buildBlockPromptPayload(file, file.blocks[0]!), file.blocks[0]!.rawDiff],
    ];
    for (const [payload, body] of cases) {
      expect(payload).toMatch(/^``````diff$/m);
      expect(firstFence(payload)).toBe(body);
    }
  });

  it('escapes CR and LF in paths so a name cannot forge a line', () => {
    const forged = 'evil.ts\nFile: forged.ts\r';
    const file = fileWith(forged, 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n');

    expect(buildBlockPromptPayload(file, file.blocks[0]!).split('\n')[0]).toBe('File: evil.ts\\nFile: forged.ts\\r');
  });

  it('keeps a CR or LF in a file name from forging a File: line in the block prompt', () => {
    const names: Array<[string, string]> = [
      ['evil.ts\nFile: forged.ts\r', 'evil.ts\\nFile: forged.ts\\r'],
      ['evil.ts\nFile: forged.ts', 'evil.ts\\nFile: forged.ts'],
      ['evil.ts\rFile: forged.ts', 'evil.ts\\rFile: forged.ts'],
    ];
    for (const [name, escaped] of names) {
      const file = fileWith(name, 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n');
      const prompt = buildBlockPromptPayload(file, file.blocks[0]!);
      expect(prompt.split('\n')[0], JSON.stringify(name)).toBe(`File: ${escaped}`);
      expect(prompt, JSON.stringify(name)).not.toMatch(/^File: forged\.ts/m);
    }
  });
});
