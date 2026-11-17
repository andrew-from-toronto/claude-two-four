import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface EditSpec {
  file_path: string;
  old_string?: string | undefined;
  new_string: string;
  replace_all?: boolean | undefined;
}

export interface FileOutcome {
  path: string;
  created: boolean;
  edits: number;
}

export interface EditFailure {
  index: number;
  path: string;
  reason: string;
}

export type BatchResult = { ok: true; files: FileOutcome[] } | { ok: false; failures: EditFailure[] };

interface FileState {
  path: string;
  original: Buffer | null;
  text: string | null;
  bom: boolean;
  mode: number | undefined;
  created: boolean;
  edits: number;
}

const UTF8_BOM = '\uFEFF';

const TYPOGRAPHY: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u00A0': ' ',
  '\u2026': '...',
};

/** Folds typography and CRLF; map[i] is the original index of norm[i], plus a trailing end sentinel. */
export function normalize(text: string): { norm: string; map: number[] } {
  const parts: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\r' && text[i + 1] === '\n') {
      parts.push('\n');
      map.push(i);
      i++;
      continue;
    }
    const rep = TYPOGRAPHY[ch] ?? ch;
    for (const r of rep) {
      parts.push(r);
      map.push(i);
    }
  }
  map.push(text.length);
  return { norm: parts.join(''), map };
}

function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** Ranges in `text` matching `needle`, trying an exact match before the normalized one. */
export function locate(text: string, needle: string): Array<[number, number]> {
  const exact = findAll(text, needle);
  if (exact.length > 0) return exact.map((s) => [s, s + needle.length]);
  const n = normalize(needle).norm;
  if (n.length === 0) return [];
  const t = normalize(text);
  return findAll(t.norm, n).map((s) => [t.map[s]!, t.map[s + n.length]!]);
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  let overlap = 0;
  for (const [g, n] of bigrams(b)) overlap += Math.min(n, ga.get(g) ?? 0);
  return (2 * overlap) / (a.length + b.length - 2);
}

/** Up to `max` lines of `text` most similar to the first non-blank line of `needle`, numbered from 1. */
export function closestLines(text: string, needle: string, max = 3): string {
  const target = normalize(needle).norm.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!target) return '';
  return text
    .split(/\r?\n/)
    .map((line, i) => ({ i, line, score: dice(normalize(line).norm.trim(), target) }))
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((s) => `    ${s.i + 1}: ${s.line.length > 160 ? `${s.line.slice(0, 160)}...` : s.line}`)
    .join('\n');
}

function splice(text: string, ranges: Array<[number, number]>, replacement: string): string {
  let out = '';
  let last = 0;
  for (const [start, end] of ranges) {
    out += text.slice(last, start) + replacement;
    last = end;
  }
  return out + text.slice(last);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Resolves symlinks and junctions so writes land on the target instead of replacing the link. */
async function resolveTarget(filePath: string, baseDir: string): Promise<string> {
  const abs = path.resolve(baseDir, filePath);
  try {
    return await fs.realpath(abs);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    try {
      return path.join(await fs.realpath(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

async function loadFile(real: string): Promise<FileState | string> {
  const state: FileState = { path: real, original: null, text: null, bom: false, mode: undefined, created: false, edits: 0 };
  let stat;
  try {
    stat = await fs.stat(real);
  } catch (e) {
    if (isNotFound(e)) return state;
    return errorMessage(e);
  }
  if (!stat.isFile()) return 'not a regular file';
  const buf = await fs.readFile(real);
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return 'UTF-16 files are not supported';
  if (buf.includes(0)) return 'file looks binary';
  state.bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  state.original = buf;
  state.text = buf.toString('utf8', state.bom ? 3 : 0);
  state.mode = stat.mode;
  return state;
}

function applyEdit(state: FileState, spec: EditSpec): string | null {
  if (spec.old_string === undefined) {
    if (state.text !== null) {
      return state.created ? 'file is already created earlier in this batch' : 'file already exists; pass old_string to edit it';
    }
    state.text = spec.new_string;
    state.created = true;
    state.edits++;
    return null;
  }
  if (state.text === null) return 'file does not exist; omit old_string to create it';
  if (spec.old_string === '') return 'old_string is empty; omit it to create a new file';
  if (spec.old_string === spec.new_string) return 'old_string and new_string are identical';
  const ranges = locate(state.text, spec.old_string);
  if (ranges.length === 0) {
    const hint = closestLines(state.text, spec.old_string);
    return hint ? `old_string not found; closest lines:\n${hint}` : 'old_string not found';
  }
  if (ranges.length > 1 && !spec.replace_all) {
    return `old_string matches ${ranges.length} times; add surrounding context or set replace_all`;
  }
  const replacement = state.text.includes('\r\n') ? spec.new_string.replace(/\r?\n/g, '\r\n') : spec.new_string;
  state.text = splice(state.text, ranges, replacement);
  state.edits++;
  return null;
}

async function commit(states: FileState[]): Promise<void> {
  const temps: Array<{ state: FileState; temp: string }> = [];
  try {
    for (const state of states) {
      if (state.created) await fs.mkdir(path.dirname(state.path), { recursive: true });
      const temp = `${state.path}.${randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(temp, (state.bom ? UTF8_BOM : '') + state.text, { encoding: 'utf8', mode: state.mode, flag: 'wx' });
      temps.push({ state, temp });
    }
  } catch (e) {
    await Promise.all(temps.map((t) => fs.rm(t.temp, { force: true })));
    throw e;
  }
  let renamed = 0;
  try {
    for (const { state, temp } of temps) {
      await fs.rename(temp, state.path);
      renamed++;
    }
  } catch (e) {
    for (const { state } of temps.slice(0, renamed)) {
      await (state.original === null ? fs.rm(state.path, { force: true }) : fs.writeFile(state.path, state.original));
    }
    await Promise.all(temps.slice(renamed).map((t) => fs.rm(t.temp, { force: true })));
    throw e;
  }
}

/** Applies every edit in order, writing nothing unless all of them succeed. */
export async function runBatch(edits: EditSpec[], baseDir: string): Promise<BatchResult> {
  const states = new Map<string, FileState>();
  const failures: EditFailure[] = [];
  for (const [index, spec] of edits.entries()) {
    const fail = (reason: string) => failures.push({ index, path: spec.file_path, reason });
    let real: string;
    try {
      real = await resolveTarget(spec.file_path, baseDir);
    } catch (e) {
      fail(errorMessage(e));
      continue;
    }
    let state = states.get(real);
    if (!state) {
      const loaded = await loadFile(real);
      if (typeof loaded === 'string') {
        fail(loaded);
        continue;
      }
      state = loaded;
      states.set(real, state);
    }
    const error = applyEdit(state, spec);
    if (error) fail(error);
  }
  if (failures.length > 0) return { ok: false, failures };
  const changed = [...states.values()].filter((s) => s.edits > 0);
  try {
    await commit(changed);
  } catch (e) {
    return { ok: false, failures: [{ index: -1, path: '', reason: `write failed, all changes rolled back: ${errorMessage(e)}` }] };
  }
  return { ok: true, files: changed.map((s) => ({ path: s.path, created: s.created, edits: s.edits })) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeFile(f: FileOutcome): string {
  const edits = f.created ? f.edits - 1 : f.edits;
  const parts = [...(f.created ? ['created'] : []), ...(edits > 0 ? [plural(edits, 'edit')] : [])];
  return `  ${f.path} (${parts.join(', ')})`;
}

export function formatResult(result: BatchResult, total: number): string {
  if (result.ok) {
    return `Applied ${plural(total, 'edit')} to ${plural(result.files.length, 'file')}:\n${result.files.map(describeFile).join('\n')}`;
  }
  const lines = result.failures.map((f) => (f.index < 0 ? `  ${f.reason}` : `  #${f.index + 1} ${f.path}: ${f.reason}`));
  return `No files changed. ${result.failures.length} of ${plural(total, 'edit')} failed:\n${lines.join('\n')}`;
}