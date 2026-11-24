const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_LINE = 400;

/** Strips colour codes and carriage-return redraws, and clips long lines. */
export function clean(line: string): string {
  const s = (line.replace(ANSI, '').split('\r').filter(Boolean).pop() ?? '').trimEnd();
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}...` : s;
}

/** Accepts a leading PCRE-style (?i), (?m) or (?s) group, which JavaScript regex rejects, as flags. */
export function compilePattern(source: string, ignoreCase = false): RegExp {
  const m = /^\(\?([ims]+)\)/.exec(source);
  const flags = new Set(m ? m[1]!.split('') : []);
  if (ignoreCase) flags.add('i');
  return new RegExp(m ? source.slice(m[0].length) : source, [...flags].join(''));
}
