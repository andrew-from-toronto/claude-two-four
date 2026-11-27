import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import * as z from 'zod/v4';

type PendingRequest = { resolve: (result: unknown) => void; reject: (error: Error) => void };
const envelope = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

export interface CodexConnection {
  request(method: string, params: object): Promise<unknown>;
  close(error?: Error): void;
}

export interface CodexEvents {
  notification(method: string, params: unknown): void;
  closed(error: Error): void;
}

export type ConnectCodex = (events: CodexEvents) => CodexConnection;

export class CodexAppServer implements CodexConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private stderr = '';
  private error?: Error;

  constructor(cwd: string, version: string, private readonly events: CodexEvents) {
    this.child = process.platform === 'win32'
      ? spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', 'codex app-server --listen stdio://'], {
        cwd,
        env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
      : spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd, detached: true });

    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.receive(line));
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.once('error', (error) => this.close(new Error(`Could not launch Codex CLI: ${error.message}`)));
    this.child.once('close', (code, signal) => {
      const message = this.stderr.trim();
      this.close(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'})${message ? `: ${message}` : ''}`));
    });
    this.child.stdin.on('error', (error) => this.close(new Error(`Codex app-server input failed: ${error.message}`)));

    this.ready = this.call('initialize', { clientInfo: { name: 'claude_codex_agents', title: 'Claude Codex Agents', version } })
      .then(() => this.write({ method: 'initialized' }));
    void this.ready.catch((error: Error) => this.close(error));
  }

  async request(method: string, params: object): Promise<unknown> {
    await this.ready;
    return this.call(method, params);
  }

  close(error = new Error('Codex session closed')): void {
    if (this.error) return;
    this.error = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.killProcessTree();
    this.child.stdin.destroy();
    this.events.closed(error);
  }

  private killProcessTree(): void {
    const { pid, exitCode, signalCode } = this.child;
    if (pid === undefined || exitCode !== null || signalCode !== null) return;
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      execFile(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.child.kill();
      }
    }
  }

  private call(method: string, params: object): Promise<unknown> {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Codex app-server timed out handling ${method}`);
        if (method === 'account/rateLimits/read') {
          this.pending.delete(id);
          reject(error);
        } else this.close(error);
      }, 30_000);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ id, method, params });
    });
  }

  private write(message: object): void {
    if (!this.error) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (this.error || !line.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.close(new Error('Codex app-server sent invalid JSON'));
      return;
    }
    const parsed = envelope.safeParse(json);
    if (!parsed.success) return;
    const { id, method, params, result, error } = parsed.data;
    if (method && id !== undefined) {
      this.write({ id, error: { code: -32601, message: `Codex Agents does not handle ${method}` } });
    } else if (method) {
      this.events.notification(method, params);
    } else if (typeof id === 'number') {
      const request = this.pending.get(id);
      this.pending.delete(id);
      if (error) request?.reject(new Error(error.message));
      else request?.resolve(result);
    }
  }
}
