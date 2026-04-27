import {describe, expect, it} from 'vitest';
import {applyTreeCollapse, buildTreeRows, findTreeSelectionPath, formatTreePayload} from '../src/tree.js';

describe('buildTreeRows', () => {
  it('expands changed file paths into a stable directory tree', () => {
    const rows = buildTreeRows([
      '.cursor/planning/stream-feeds-v2-to-v3-mobile-migration-execplan.md',
      'CLAUDE.md',
      'healthline-cares-core/containers/StreamV3ThreadContainer.js',
      'healthline-cares-core/lib/stream-v3/StreamV3Api.js',
    ]);

    expect(rows.map((row) => ({kind: row.kind, label: row.label, depth: row.depth, path: row.path}))).toEqual([
      {kind: 'file', label: 'CLAUDE.md', depth: 0, path: 'CLAUDE.md'},
      {kind: 'dir', label: '.cursor', depth: 0, path: '.cursor'},
      {kind: 'dir', label: 'planning', depth: 1, path: '.cursor/planning'},
      {
        kind: 'file',
        label: 'stream-feeds-v2-to-v3-mobile-migration-execplan.md',
        depth: 2,
        path: '.cursor/planning/stream-feeds-v2-to-v3-mobile-migration-execplan.md',
      },
      {kind: 'dir', label: 'healthline-cares-core', depth: 0, path: 'healthline-cares-core'},
      {kind: 'dir', label: 'containers', depth: 1, path: 'healthline-cares-core/containers'},
      {
        kind: 'file',
        label: 'StreamV3ThreadContainer.js',
        depth: 2,
        path: 'healthline-cares-core/containers/StreamV3ThreadContainer.js',
      },
      {kind: 'dir', label: 'lib', depth: 1, path: 'healthline-cares-core/lib'},
      {kind: 'dir', label: 'stream-v3', depth: 2, path: 'healthline-cares-core/lib/stream-v3'},
      {
        kind: 'file',
        label: 'StreamV3Api.js',
        depth: 3,
        path: 'healthline-cares-core/lib/stream-v3/StreamV3Api.js',
      },
    ]);
  });

  it('attaches status metadata to file rows', () => {
    const rows = buildTreeRows(
      ['src/app.ts', 'src/new.ts'],
      new Map([
        ['src/app.ts', 'modified'],
        ['src/new.ts', 'added'],
      ]),
    );

    expect(rows.filter((row) => row.kind === 'file').map((row) => ({
      path: row.path,
      status: row.status,
    }))).toEqual([
      {path: 'src/app.ts', status: 'modified'},
      {path: 'src/new.ts', status: 'added'},
    ]);
  });

  it('collapses nested directory descendants while keeping sibling rows visible', () => {
    const rows = buildTreeRows([
      'apps/web/src/App.tsx',
      'apps/web/test/App.test.tsx',
      'apps/api/src/server.ts',
      'README.md',
    ]);

    const collapsed = applyTreeCollapse(rows, new Set(['apps/web']));

    expect(collapsed.map((row) => ({
      kind: row.kind,
      path: row.path,
      expanded: row.expanded,
    }))).toEqual([
      {kind: 'file', path: 'README.md', expanded: undefined},
      {kind: 'dir', path: 'apps', expanded: true},
      {kind: 'dir', path: 'apps/api', expanded: true},
      {kind: 'dir', path: 'apps/api/src', expanded: true},
      {kind: 'file', path: 'apps/api/src/server.ts', expanded: undefined},
      {kind: 'dir', path: 'apps/web', expanded: false},
    ]);
  });

  it('selects the collapsed parent when the active file is hidden', () => {
    const rows = applyTreeCollapse(
      buildTreeRows(['apps/web/src/App.tsx', 'apps/api/src/server.ts']),
      new Set(['apps/web']),
    );

    expect(findTreeSelectionPath(rows, 'apps/web/src/App.tsx')).toBe('apps/web');
    expect(findTreeSelectionPath(rows, 'apps/api/src/server.ts')).toBe('apps/api/src/server.ts');
  });

  it('formats the full changed-file tree for copy payloads', () => {
    const rows = buildTreeRows(
      ['README.md', 'src/app.ts', 'src/new.ts'],
      new Map([
        ['README.md', 'modified'],
        ['src/app.ts', 'modified'],
        ['src/new.ts', 'added'],
      ]),
    );

    expect(formatTreePayload(rows)).toBe([
      'Changed files',
      '• README.md M',
      '▾ src',
      '  • app.ts M',
      '  • new.ts A',
    ].join('\n'));
  });
});
