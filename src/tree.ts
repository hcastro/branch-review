import type {FileStatus} from './git.js';

export type TreeRow = {
  kind: 'dir' | 'file';
  label: string;
  depth: number;
  path: string;
  status?: FileStatus;
};

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
