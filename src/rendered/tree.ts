import {
  mergeBaseOidOperation,
  runOperationAsync,
  treeEntriesOperation,
  treeOidOperation,
  untrackedStateOperation,
  type GitOperation,
  type TreeEntry,
} from '../git.js';

// What git holds at a ref, read once per tree for the session: the asset
// rule asks it which file a page's image names, in what mode, under which
// id. Answers that depend on the work tree (is this untracked, is it
// ignored) are asked again for each new review.

// `signal` stops a call that has run too long.
export type RunOperation = <T>(operation: GitOperation<T>, scope?: {signal?: AbortSignal}) => Promise<T>;

export type TreeIndex = {
  get(repoPath: string): TreeEntry | undefined;
  /** The path the tree holds that differs from `repoPath` only in case, if one does. */
  caseMatch(repoPath: string): string | undefined;
  /** The symlink or submodule a folder of `repoPath` is, if one is. */
  linkAbove(repoPath: string): {path: string; mode: string} | undefined;
  /** Whether `repoPath` is a folder the tree holds files in. */
  hasFolder(repoPath: string): boolean;
};

// A session sees few trees: the base, the branch, and a branch tip that
// moved during a watch.
const MAX_TREES = 4;

export function treeIndex(entries: ReadonlyMap<string, TreeEntry>): TreeIndex {
  let folded: Map<string, string> | null = null;
  let folders: Set<string> | null = null;
  return {
    get: (repoPath) => entries.get(repoPath),
    caseMatch(repoPath) {
      // Built on the first miss only: most pages never need it.
      if (!folded) {
        folded = new Map();
        for (const name of entries.keys()) if (!folded.has(name.toLowerCase())) folded.set(name.toLowerCase(), name);
      }
      const match = folded.get(repoPath.toLowerCase());
      return match !== undefined && match !== repoPath ? match : undefined;
    },
    linkAbove(repoPath) {
      const parts = repoPath.split('/');
      for (let end = 1; end < parts.length; end += 1) {
        const folder = parts.slice(0, end).join('/');
        const entry = entries.get(folder);
        if (entry && (entry.mode === '120000' || entry.mode === '160000')) return {path: folder, mode: entry.mode};
      }
      return undefined;
    },
    hasFolder(repoPath) {
      if (!folders) {
        folders = new Set();
        for (const name of entries.keys()) {
          for (let at = name.indexOf('/'); at >= 0; at = name.indexOf('/', at + 1)) folders.add(name.slice(0, at));
        }
      }
      return folders.has(repoPath);
    },
  };
}

export function createTreeReader({cwd, run = runOperationAsync}: {cwd: string; run?: RunOperation}) {
  // By tree id: a tree's content never changes.
  const trees = new Map<string, Promise<TreeIndex>>();
  // By review epoch: a branch can move, and the work tree can change.
  let epoch = -1;
  let refs = new Map<string, Promise<string>>();
  let untracked = new Map<string, Promise<'untracked' | 'ignored' | null>>();

  const atEpoch = (next: number) => {
    if (next === epoch) return;
    epoch = next;
    refs = new Map();
    untracked = new Map();
  };

  // A failed read is asked again next time.
  const remember = <K, V>(map: Map<K, Promise<V>>, key: K, make: () => Promise<V>) => {
    let value = map.get(key);
    if (!value) {
      value = make();
      map.set(key, value);
      value.catch(() => map.delete(key));
    }
    return value;
  };

  // `base...branch` names the tree of their merge base, as the diff does.
  const treeOid = (ref: string) => remember(refs, ref, async () => {
    const [base, branch] = ref.split('...');
    const commit = branch !== undefined ? await run(mergeBaseOidOperation(cwd, base!, branch)) : ref;
    return run(treeOidOperation(cwd, commit));
  });

  return {
    /** The id of the tree `ref` names, as the diff reads it. */
    treeOid(ref: string, reviewEpoch: number) {
      atEpoch(reviewEpoch);
      return treeOid(ref);
    },
    /** The files `ref` holds. `epoch` names the review asking. */
    async tree(ref: string, reviewEpoch: number): Promise<TreeIndex> {
      atEpoch(reviewEpoch);
      const oid = await treeOid(ref);
      const index = remember(trees, oid, async () => treeIndex(await run(treeEntriesOperation(cwd, oid))));
      // Oldest first: a Map keeps insertion order.
      for (const old of trees.keys()) {
        if (trees.size <= MAX_TREES) break;
        if (old !== oid) trees.delete(old);
      }
      return index;
    },
    /** Whether a path git doesn't track is untracked or ignored in the work tree, as of the review `epoch`. */
    untrackedState(repoPath: string, reviewEpoch: number) {
      atEpoch(reviewEpoch);
      return remember(untracked, repoPath, () => run(untrackedStateOperation(cwd, repoPath)));
    },
  };
}

export type TreeReader = ReturnType<typeof createTreeReader>;
