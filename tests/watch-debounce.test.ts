import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {debounce} from '../src/watch/debounce.js';
import {createEventDeduper} from '../src/watch/repoWatcher.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('debounce with a max wait', () => {
  it('still fires about once a second while calls keep coming every 100 ms', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 200, {maxWaitMs: 1000});
    const fireTimes: number[] = [];
    callback.mockImplementation(() => fireTimes.push(Date.now()));
    const start = Date.now();

    for (let elapsed = 0; elapsed < 5000; elapsed += 100) {
      debounced();
      vi.advanceTimersByTime(100);
    }

    expect(fireTimes.length).toBeGreaterThanOrEqual(4);
    expect(fireTimes[0] - start).toBeLessThanOrEqual(1000);
    for (let index = 1; index < fireTimes.length; index += 1) {
      expect(fireTimes[index] - fireTimes[index - 1]).toBeLessThanOrEqual(1100);
    }
  });

  it('fires once for a single burst, after the quiet period', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 200, {maxWaitMs: 1000});

    for (let index = 0; index < 10; index += 1) {
      debounced();
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(194);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh max wait after it fires', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 200, {maxWaitMs: 1000});

    debounced();
    vi.advanceTimersByTime(300);
    expect(callback).toHaveBeenCalledTimes(1);

    // A later single call waits the normal quiet period, not a stale max wait.
    vi.advanceTimersByTime(2000);
    debounced();
    vi.advanceTimersByTime(199);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('without a max wait, waits for the calls to stop', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 200);

    for (let elapsed = 0; elapsed < 3000; elapsed += 100) {
      debounced();
      vi.advanceTimersByTime(100);
    }
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cancel drops a pending call', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 200, {maxWaitMs: 1000});

    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(2000);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('watch event deduper', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  });

  function tempFile(text: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-dedupe-'));
    dirs.push(dir);
    const filePath = path.join(dir, 'file.txt');
    fs.writeFileSync(filePath, text);
    return filePath;
  }

  it('drops a repeat event for a path whose mtime, ctime and size did not move', () => {
    const filePath = tempFile('one\n');
    const isNew = createEventDeduper(0);

    expect(isNew(filePath)).toBe(true);
    // A read changes only atime.
    fs.readFileSync(filePath);
    expect(isNew(filePath)).toBe(false);
  });

  it('passes events after a write, a delete and a re-create', () => {
    const filePath = tempFile('one\n');
    const isNew = createEventDeduper(0);
    expect(isNew(filePath)).toBe(true);

    fs.appendFileSync(filePath, 'two\n');
    expect(isNew(filePath)).toBe(true);

    fs.rmSync(filePath);
    expect(isNew(filePath)).toBe(true);
    expect(isNew(filePath)).toBe(false);

    fs.writeFileSync(filePath, 'back\n');
    expect(isNew(filePath)).toBe(true);
  });

  it('drops the first event for a path unchanged since the watcher started, but not for one changed after', () => {
    const filePath = tempFile('one\n');
    const isNew = createEventDeduper(Date.now() + 60_000);
    expect(isNew(filePath)).toBe(false);

    const changedAfterStart = createEventDeduper(Date.now() - 60_000);
    expect(changedAfterStart(filePath)).toBe(true);
    expect(changedAfterStart(path.join(path.dirname(filePath), 'missing.txt'))).toBe(true);
  });
});
