// Normalize a bounded, NUL-free query before passing it to parameterized FTS5 MATCH.
export function normalizeQuery(query: string): string {
  // NUL placeholders cannot collide with input: validation rejects NUL before this step.
  const phrases: string[] = [];
  let normalized = query.replace(/"[^"]*"/g, phrase => {
    phrases.push(phrase);
    return `\0Q${phrases.length - 1}\0`;
  });
  normalized = normalized.replace(/[+{}():"^@/#&|~\[\]<>,;!?$=\\'%]/g, ' ');
  normalized = normalized.replace(/\*+/g, '*').replace(/(^|\s)\*/g, '$1');
  // Keep Unicode words intact instead of using JavaScript's ASCII-only word boundary.
  normalized = normalized.trim().replace(/^(AND|OR|NOT)(?![\p{L}\p{N}\p{M}_])\s*/iu, '').trim().replace(/\s+(AND|OR|NOT)\s*$/i, '');
  normalized = normalized.replace(/(?<![\p{L}\p{N}\p{M}_])([\p{L}\p{N}\p{M}_]+(?:[._-][\p{L}\p{N}\p{M}_]+)+)(?![\p{L}\p{N}\p{M}_])/gu, '"$1"');
  return normalized.replace(/\0Q(\d+)\0/g, (_, index: string) => phrases[Number(index)]).trim();
}
