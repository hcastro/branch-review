import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {afterAll, describe, expect, it} from 'vitest';
import {cleanupTempDirs, makeTempDir} from './core-helpers.js';

// The UI process never loads the markdown parser: the app, and the rendered
// service it loads before it mounts, reach the renderer only through the
// rendered worker. Walked over static imports only, since dynamic ones
// load later, if at all; the worker's own entry reaches it as it should.

const ROOT = path.join(import.meta.dirname, '..');
const PARSER = /^(?:unified|remark-|rehype-|mdast-|hast-|micromark|gemoji$|yaml$|@wooorm\/starry-night)/;
const isParser = (name: string) => name === 'src/rendered/markdown.ts' || PARSER.test(name);

afterAll(() => cleanupTempDirs());

// What `entry` reaches by static imports: our modules and the packages they name.
async function sourceClosure(entry: string) {
  const result = await esbuild.build({absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, metafile: true, format: 'esm', platform: 'node', packages: 'external', outdir: 'out', logLevel: 'silent', jsx: 'automatic'});
  const inputs = result.metafile.inputs;
  const reached = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (reached.has(at)) continue;
    reached.add(at);
    for (const imported of inputs[at]?.imports ?? []) {
      if (imported.kind !== 'import-statement') continue;
      if (imported.external) reached.add(imported.path);
      else stack.push(imported.path);
    }
  }
  return reached;
}

// The packages a built file reaches by static imports, following its chunks.
function builtClosure(dir: string, file: string) {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const stack = [file];
  const STATIC = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{},\s$]+from\s*)?["']([^"']+)["']/g;
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    const text = fs.readFileSync(path.join(dir, at), 'utf8');
    for (const match of text.matchAll(STATIC)) {
      const spec = match[1]!;
      if (spec.startsWith('./') || spec.startsWith('../')) stack.push(path.normalize(path.join(path.dirname(at), spec)));
      else packages.add(spec);
    }
  }
  return packages;
}

describe('the markdown parser stays out of the UI process', () => {
  it('is reached by no static import from the app or from the rendered service', async () => {
    for (const entry of ['src/cli.tsx', 'src/rendered/service.ts']) {
      const reached = [...await sourceClosure(entry)];
      expect(reached.filter(isParser), entry).toEqual([]);
      expect(reached.length, entry).toBeGreaterThan(20);
    }
    // The worker does reach it, so the walk sees what it is looking for.
    expect([...await sourceClosure('src/renderedWorker.ts')].filter(isParser)).toEqual(expect.arrayContaining(['src/rendered/markdown.ts', 'unified']));
  });

  it('is in no chunk dist/cli.js loads statically, as the build splits them', async () => {
    const out = makeTempDir('branch-review-closure-');
    // tsup's entries and output, with every package left outside the bundle as its dependencies are.
    await esbuild.build({absWorkingDir: ROOT, entryPoints: ['src/cli.tsx', 'src/refreshWorker.ts', 'src/mediaWorker.ts', 'src/renderedWorker.ts'], bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', outdir: out, logLevel: 'silent', jsx: 'automatic'});
    const packages = [...builtClosure(out, 'cli.js')];
    expect(packages.filter(isParser)).toEqual([]);
    expect(packages).toContain('ink');
    expect([...builtClosure(out, 'renderedWorker.js')].filter(isParser)).toEqual(expect.arrayContaining(['unified']));
    // The installed build, when one is newer than the service it bundles.
    const dist = path.join(ROOT, 'dist');
    const built = path.join(dist, 'cli.js');
    if (fs.existsSync(built) && fs.statSync(built).mtimeMs > fs.statSync(path.join(ROOT, 'src/rendered/service.ts')).mtimeMs) {
      expect([...builtClosure(dist, 'cli.js')].filter(isParser)).toEqual([]);
    }
  });
});
