import {createHash, randomInt} from 'node:crypto';

/**
 * Stable ids for rendered blocks: `b-<first 8 hex of sha256 of the block's
 * source>-<occurrence>`. An unchanged block keeps its id across edits, so a
 * later refresh can tell which blocks are new. Two blocks with the same text
 * are told apart by their order. One counter per render.
 */
export function createBlockIds() {
  const seen = new Map<string, number>();
  return (sourceText: string) => {
    const hash = createHash('sha256').update(sourceText).digest('hex').slice(0, 8);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    return `b-${hash}-${occurrence}`;
  };
}

/**
 * A data attribute name made fresh for one render. Our own nodes carry it
 * through the sanitizer, the only schema that allows it is this render's,
 * and it's removed right after, so repo HTML can't guess it to forge a
 * change bar or an alert. Letters only, so the hast property name and the
 * HTML attribute name map one to one (`dataBrabc` is `data-brabc`).
 */
export function privateAttribute(): {property: string; attribute: string} {
  let letters = '';
  for (let index = 0; index < 16; index += 1) letters += String.fromCharCode(97 + randomInt(26));
  return {property: `dataBr${letters}`, attribute: `data-br${letters}`};
}
