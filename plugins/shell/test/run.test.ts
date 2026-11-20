import { promises as fs } from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/run.js';

describe('runCommand', () => {
  it('returns the exit code, saves full output and returns short output whole', async () => {
    const { ok, text } = await runCommand({ command: 'echo hello\nexit 3' }, os.tmpdir());
    expect(ok).toBe(false);
    expect(text).toMatch(/^exit 3 in [\d.]+s, 1 lines\. Full output: /);
    expect(text).toContain('-- output\nhello');
    const file = /Full output: (.+\.log)/.exec(text)![1]!;
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('hello');
  }, 30_000);

  it('reports a missing cwd as such', async () => {
    const { ok, text } = await runCommand({ command: 'echo hi', cwd: 'no-such-dir-here' }, os.tmpdir());
    expect(ok).toBe(false);
    expect(text).toMatch(/^cwd not found: /);
  });

  it('kills the command at the timeout', async () => {
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const { ok, text } = await runCommand({ command, timeout_seconds: 1 }, os.tmpdir());
    expect(ok).toBe(false);
    expect(text).toMatch(/^timed out after 1s/);
  }, 30_000);
});
