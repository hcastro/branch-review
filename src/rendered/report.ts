import type {FileStatus} from '../git.js';
import type {LinkStatus, PageImageUse, PageLink, RefusedReason} from './markdown.js';
import {anchorTarget, imageFinding, linkReason} from './words.js';

// The link and anchor report: what on the review's pages won't resolve once
// they are on GitHub. Each page's render says how its links and images
// resolved; a link to a heading on another rendered page is checked here,
// against that page's anchors, since one render never sees another page.
// Pure: the TUI's service and `--export-html` both read their pages' answers
// through it.

/** A page as the report reads it: what its render said of its links, images and anchors. */
export type ReportSource = {path: string; status: FileStatus; links: readonly PageLink[]; images: readonly PageImageUse[]; anchors: readonly string[]};

export type FindingKind = Exclude<LinkStatus, 'ok' | 'outside' | 'unchecked'> | RefusedReason;

/** One thing GitHub won't resolve: where it is, what the page wrote, and why. */
export type Finding = {path: string; line: number; target: string; what: 'link' | 'image'; kind: FindingKind; reason: string};

// A link with no answer in time is no finding: a wrong mark is worse than a missing one.
const isLinkFinding = (status: LinkStatus): status is Exclude<LinkStatus, 'ok' | 'outside' | 'unchecked'> => status !== 'ok' && status !== 'outside' && status !== 'unchecked';

/**
 * The findings of every page, in page order and by line, and for each page
 * the links to another page's heading that isn't there (by their `ref`
 * index), which the page draws broken. A deleted file's page is gone on
 * GitHub, so its links are no finding. A heading on a page not rendered yet
 * is no finding either.
 */
export function linkReport(pages: readonly ReportSource[]): {findings: Finding[]; broken: Map<string, number[]>} {
  const anchors = new Map(pages.map((page) => [page.path, new Set(page.anchors)]));
  const findings: Finding[] = [];
  const broken = new Map<string, number[]>();
  for (const page of pages) {
    if (page.status === 'deleted') continue;
    const own: Finding[] = [];
    for (const link of page.links) {
      if (isLinkFinding(link.status)) {
        own.push({path: page.path, line: link.line, target: link.href, what: 'link', kind: link.status, reason: linkReason(link.status, link.hint)});
        continue;
      }
      const ref = link.ref;
      const known = ref ? anchors.get(ref.path) : undefined;
      if (!ref || !known || anchorTarget(known, ref.anchor) !== null) continue;
      own.push({path: page.path, line: link.line, target: link.href, what: 'link', kind: 'badAnchor', reason: linkReason('badAnchor')});
      const refs = broken.get(page.path);
      if (refs) refs.push(ref.index);
      else broken.set(page.path, [ref.index]);
    }
    for (const image of page.images) {
      if (image.status === 'embed' || image.status === 'skipped') continue;
      const reason = imageFinding(image.status, image.hint);
      if (reason !== null) own.push({path: page.path, line: image.line, target: image.url, what: 'image', kind: image.status, reason});
    }
    findings.push(...own.sort((left, right) => left.line - right.line));
  }
  return {findings, broken};
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The findings in a few words, as the rail and the strip say them: the
 * links that won't resolve, then the images by reason, the most first.
 */
export function findingNotes(findings: readonly Finding[]): string[] {
  const links = findings.filter((finding) => finding.what === 'link').length;
  const images = new Map<string, number>();
  for (const finding of findings) {
    if (finding.what !== 'image') continue;
    // By its reason alone: a case mismatch counts as one, whichever names it confused.
    const reason = imageFinding(finding.kind as RefusedReason) ?? finding.reason;
    images.set(reason, (images.get(reason) ?? 0) + 1);
  }
  const byCount = [...images].sort((left, right) => right[1] - left[1]);
  return [...(links > 0 ? [`${plural(links, 'link')} won't resolve`] : []), ...byCount.map(([reason, count]) => `${plural(count, 'image')}: ${reason}`)];
}

/**
 * Where the pages show `imagePath`: each page and line, in page order. A
 * deleted file's page is gone on GitHub, so it shows nothing there.
 */
export function appearances(pages: ReadonlyArray<Pick<ReportSource, 'path' | 'images'> & {status?: FileStatus}>, imagePath: string): Array<{path: string; line: number}> {
  return pages.filter((page) => page.status !== 'deleted').flatMap((page) => [...new Set(page.images.filter((image) => image.path === imagePath).map((image) => image.line))].map((line) => ({path: page.path, line})));
}
