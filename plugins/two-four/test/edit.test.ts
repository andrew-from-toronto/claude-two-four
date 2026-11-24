import { mkdtemp, readFile, rm, symlink, writeFile, lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatResult, locate, runBatch } from '../src/edit.js';

let dir: string;
const p = (name: string) => path.join(dir, name);
const read = (name: string) => readFile(p(name), 'utf8');

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'batch-edit-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runBatch', () => {
  it('applies edits across files and chains edits to the same file', async () => {
    await writeFile(p('a.ts'), 'const a = 1;\nconst b = 2;\n');
    await writeFile(p('b.ts'), 'export const x = a;\n');
    const result = await runBatch(
      [
        { file_path: p('a.ts'), old_string: 'const a = 1;', new_string: 'const alpha = 1;' },
        { file_path: p('a.ts'), old_string: 'const alpha = 1;\nconst b', new_string: 'const alpha = 1;\nconst beta' },
        { file_path: p('b.ts'), old_string: '= a;', new_string: '= alpha;' },
      ],
      dir,
    );
    expect(result.ok).toBe(true);
    expect(await read('a.ts')).toBe('const alpha = 1;\nconst beta = 2;\n');
    expect(await read('b.ts')).toBe('export const x = alpha;\n');
    expect(formatResult(result, 3)).toContain('Applied 3 edits to 2 files');
  });

  it('writes nothing when any edit fails and reports every failure', async () => {
    await writeFile(p('a.ts'), 'one\n');
    await writeFile(p('b.ts'), 'two\n');
    const result = await runBatch(
      [
        { file_path: p('a.ts'), old_string: 'one', new_string: 'ONE' },
        { file_path: p('b.ts'), old_string: 'missing', new_string: 'x' },
        { file_path: p('c.ts'), old_string: 'x', new_string: 'y' },
      ],
      dir,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.index)).toEqual([1, 2]);
    expect(await read('a.ts')).toBe('one\n');
    expect(formatResult(result, 3)).toMatch(/^No files changed\. 2 of 3 edits failed/);
  });

  it('rejects ambiguous matches unless replace_all is set', async () => {
    await writeFile(p('a.txt'), 'foo foo foo');
    const ambiguous = await runBatch([{ file_path: p('a.txt'), old_string: 'foo', new_string: 'bar' }], dir);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.failures[0]!.reason).toContain('matches 3 times');
    const all = await runBatch([{ file_path: p('a.txt'), old_string: 'foo', new_string: 'bar', replace_all: true }], dir);
    expect(all.ok).toBe(true);
    expect(await read('a.txt')).toBe('bar bar bar');
  });

  it('matches across typography differences', async () => {
    await writeFile(p('a.md'), 'He said \u201chello\u201d \u2014 it\u2019s fine.\n');
    const result = await runBatch([{ file_path: p('a.md'), old_string: `said "hello" - it's`, new_string: 'said "bye" - it is' }], dir);
    expect(result.ok).toBe(true);
    expect(await read('a.md')).toBe('He said "bye" - it is fine.\n');
  });

  it('matches LF search text in CRLF files and keeps CRLF line endings', async () => {
    await writeFile(p('a.cs'), 'line1\r\nline2\r\nline3\r\n');
    const result = await runBatch([{ file_path: p('a.cs'), old_string: 'line1\nline2', new_string: 'first\nsecond\nextra' }], dir);
    expect(result.ok).toBe(true);
    expect(await read('a.cs')).toBe('first\r\nsecond\r\nextra\r\nline3\r\n');
  });

  it('creates new files, including parent folders, and refuses to overwrite', async () => {
    await writeFile(p('exists.ts'), 'keep');
    const created = await runBatch(
      [
        { file_path: p('new/dir/file.ts'), new_string: 'export {};\n' },
        { file_path: p('new/dir/file.ts'), old_string: 'export {};', new_string: 'export const y = 1;' },
      ],
      dir,
    );
    expect(created.ok).toBe(true);
    expect(await read('new/dir/file.ts')).toBe('export const y = 1;\n');
    expect(formatResult(created, 2)).toContain('(created, 1 edit)');
    const clash = await runBatch([{ file_path: p('exists.ts'), new_string: 'replaced' }], dir);
    expect(clash.ok).toBe(false);
    expect(await read('exists.ts')).toBe('keep');
  });

  it('resolves relative paths against the base directory', async () => {
    await writeFile(p('rel.txt'), 'a');
    const result = await runBatch([{ file_path: 'rel.txt', old_string: 'a', new_string: 'b' }], dir);
    expect(result.ok).toBe(true);
    expect(await read('rel.txt')).toBe('b');
  });

  it('preserves a UTF-8 BOM', async () => {
    await writeFile(p('bom.txt'), '\uFEFFhello');
    await runBatch([{ file_path: p('bom.txt'), old_string: 'hello', new_string: 'world' }], dir);
    const buf = await readFile(p('bom.txt'));
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.toString('utf8', 3)).toBe('world');
  });

  it('edits through a symlink without replacing the link', async () => {
    await mkdir(p('real'));
    await writeFile(p('real/target.md'), 'old');
    try {
      await symlink(p('real/target.md'), p('link.md'), 'file');
    } catch {
      return;
    }
    const result = await runBatch([{ file_path: p('link.md'), old_string: 'old', new_string: 'new' }], dir);
    expect(result.ok).toBe(true);
    expect((await lstat(p('link.md'))).isSymbolicLink()).toBe(true);
    expect(await read('real/target.md')).toBe('new');
  });

  it('suggests the closest lines when the search text is missing', async () => {
    await writeFile(p('a.ts'), 'function alpha() {}\nfunction betaHandler() {}\n');
    const result = await runBatch([{ file_path: p('a.ts'), old_string: 'function betaHandlr() {}', new_string: 'x' }], dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]!.reason).toContain('2: function betaHandler() {}');
  });

  it('rejects identical old and new text', async () => {
    await writeFile(p('a.txt'), 'same');
    const result = await runBatch([{ file_path: p('a.txt'), old_string: 'same', new_string: 'same' }], dir);
    expect(result.ok).toBe(false);
  });
});

describe('locate', () => {
  it('maps normalized matches back to original offsets', () => {
    const text = 'a \u201cq\u201d b';
    const [range] = locate(text, '"q"');
    expect(range).toEqual([2, 5]);
  });
});