import type {FileStatus} from './git.js';

export type TreeRow = {
  kind: 'dir' | 'file';
  label: string;
  depth: number;
  path: string;
  status?: FileStatus;
  expanded?: boolean;
};

function statusLabel(status: FileStatus | undefined) {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  if (status === 'renamed') return 'R';
  if (status === 'untracked') return 'U';
  return status ? 'M' : '';
}

type TreeNode = {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  status?: FileStatus;
  children?: Map<string, TreeNode>;
};

function compareNames(a: string, b: string) {
  return a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
}

function walk(node: TreeNode, depth: number, rows: TreeRow[]) {
  if (node.kind === 'dir') {
    rows.push({kind: 'dir', label: node.name, depth, path: node.path});

    const children = [...(node.children?.values() ?? [])].sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'dir' ? -1 : 1;
      }

      return compareNames(left.name, right.name);
    });

    for (const child of children) {
      walk(child, depth + 1, rows);
    }

    return;
  }

  rows.push({kind: 'file', label: node.name, depth, path: node.path, status: node.status});
}

export function buildTreeRows(files: string[], statusByPath?: ReadonlyMap<string, FileStatus>): TreeRow[] {
  const roots = new Map<string, TreeNode>();

  for (const filePath of [...files].sort(compareNames)) {
    const status = statusByPath?.get(filePath);
    const parts = filePath.split('/');

    if (parts.length === 1) {
      roots.set(filePath, {
        name: filePath,
        path: filePath,
        kind: 'file',
        status,
      });
      continue;
    }

    let currentMap = roots;
    let currentPath = '';

    for (const [index, part] of parts.entries()) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      const existing = currentMap.get(part);

      if (!existing) {
        const node: TreeNode = isFile
          ? {name: part, path: currentPath, kind: 'file', status}
          : {name: part, path: currentPath, kind: 'dir', children: new Map()};
        currentMap.set(part, node);
      }

      const next = currentMap.get(part)!;
      if (next.kind === 'dir') {
        currentMap = next.children!;
      }
    }
  }

  const rows: TreeRow[] = [];
  const sortedRoots = [...roots.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'file' ? -1 : 1;
    }

    return compareNames(left.name, right.name);
  });

  for (const root of sortedRoots) {
    walk(root, 0, rows);
  }

  return rows;
}

function isDescendantOf(filePath: string, directoryPath: string) {
  return filePath.startsWith(`${directoryPath}/`);
}

export function applyTreeCollapse(rows: TreeRow[], collapsedPaths: ReadonlySet<string>): TreeRow[] {
  const visibleRows: TreeRow[] = [];
  const collapsedAncestors: string[] = [];

  for (const row of rows) {
    while (
      collapsedAncestors.length > 0
      && !isDescendantOf(row.path, collapsedAncestors[collapsedAncestors.length - 1]!)
    ) {
      collapsedAncestors.pop();
    }

    if (collapsedAncestors.length > 0) continue;

    if (row.kind === 'dir') {
      const expanded = !collapsedPaths.has(row.path);
      visibleRows.push({...row, expanded});
      if (!expanded) {
        collapsedAncestors.push(row.path);
      }
      continue;
    }

    visibleRows.push(row);
  }

  return visibleRows;
}

export function findTreeSelectionPath(rows: TreeRow[], activeFilePath: string) {
  if (!activeFilePath) return '';
  if (rows.some((row) => row.kind === 'file' && row.path === activeFilePath)) {
    return activeFilePath;
  }

  let collapsedParent: TreeRow | undefined;
  for (const row of rows) {
    if (
      row.kind === 'dir'
      && row.expanded === false
      && isDescendantOf(activeFilePath, row.path)
      && (!collapsedParent || row.path.length > collapsedParent.path.length)
    ) {
      collapsedParent = row;
    }
  }

  return collapsedParent?.path ?? activeFilePath;
}

export function formatTreePayload(rows: TreeRow[]) {
  if (rows.length === 0) {
    return 'Changed files\n(no changes)';
  }

  return [
    'Changed files',
    ...rows.map((row) => {
      const glyph = row.kind === 'dir' ? '▾' : '•';
      const suffix = row.kind === 'file' ? ` ${statusLabel(row.status)}`.trimEnd() : '';
      return `${' '.repeat(row.depth * 2)}${glyph} ${row.label}${suffix}`;
    }),
  ].join('\n');
}
