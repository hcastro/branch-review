// One table of characters that must never reach the terminal as themselves,
// shared by diff content and on-screen repo strings (paths, refs, messages).
// A terminal acts on C0, DEL and C1 controls; bidi controls reorder the text
// around them; invisible format characters make two different names look the
// same (`a.ts` and `a\u200B.ts`); and one private-use character the terminal
// gives a meaning of its own.
const HIDDEN_RANGES = [
  '\\u0000-\\u001F', // C0 controls
  '\\u007F-\\u009F', // DEL and C1 controls
  '\\u00AD', // soft hyphen
  '\\u061C', // Arabic letter mark
  '\\u200B-\\u200F', // zero-width space, non-joiner, joiner; LRM, RLM
  '\\u2028\\u2029', // line and paragraph separators
  '\\u202A-\\u202E', // bidi embeddings and overrides
  '\\u2060-\\u2064', // word joiner and invisible operators
  '\\u2066-\\u2069', // bidi isolates
  '\\uFEFF', // zero-width no-break space (BOM)
  '\\u{E0000}-\\u{E007F}', // tag characters
  // Kitty image placeholder: under a foreground color, a terminal with
  // Kitty graphics draws a transmitted image in this cell, so only the
  // media layer may produce it.
  '\\u{10EEEE}',
].join('');

const HIDDEN_CHARACTERS = new RegExp(`[${HIDDEN_RANGES}]`, 'gu');

/**
 * The visible stand-in for one hidden character: caret notation for C0
 * controls (^M, ^H, ^G), U+241B for ESC, ^? for DEL, and <U+XXXX> for the rest.
 */
export function visibleMarker(char: string) {
  const code = char.codePointAt(0)!;
  if (code === 0x1B) return '␛';
  if (code < 0x20) return `^${String.fromCharCode(code + 0x40)}`;
  if (code === 0x7F) return '^?';
  return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** Replaces every hidden character in `text`, tab and newline included. */
export function escapeHiddenCharacters(text: string) {
  return text.replace(HIDDEN_CHARACTERS, visibleMarker);
}

/**
 * Replaces every hidden character except tab and newline, which keep their
 * layout meaning in multi-line text such as a patch or a stack trace.
 */
export function escapeHiddenCharactersInLines(text: string) {
  return text.replace(HIDDEN_CHARACTERS, (char) => (char === '\t' || char === '\n' ? char : visibleMarker(char)));
}

/**
 * JSON.stringify output with every hidden character in it written as a
 * `\uXXXX` escape (two for a character past U+FFFF), so it decodes to the
 * same values and none of them reaches a terminal as itself. JSON.stringify
 * already escapes C0 inside strings, so a C0 character left here is the
 * layout's own newline.
 */
export function escapeHiddenCharactersInJson(json: string) {
  return json.replace(HIDDEN_CHARACTERS, (char) => {
    if (char < ' ') return char;
    let escaped = '';
    for (let index = 0; index < char.length; index += 1) escaped += `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`;
    return escaped;
  });
}
