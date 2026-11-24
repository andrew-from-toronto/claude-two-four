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

  it('kills the command when the signal aborts', async () => {
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    const { ok, text } = await runCommand({ command }, os.tmpdir(), { signal: controller.signal });
    expect(ok).toBe(false);
    expect(text).toMatch(/^cancelled, process tree killed in /);
  }, 30_000);

  it('reports progress while the command runs', async () => {
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 2' : 'sleep 2';
    const ticks: number[] = [];
    const { ok } = await runCommand({ command }, os.tmpdir(), { onProgress: (s) => ticks.push(s), progressIntervalMs: 200 });
    expect(ok).toBe(true);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  }, 30_000);
});
