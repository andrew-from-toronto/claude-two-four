import { clean } from './text.js';

const FULL_OUTPUT_LINES = 60;
const MAX_MATCHES = 100;

const VSTEST_FAIL = /^\s*Failed (.+) \[[^\]]*\]$/;
const MTP_FAIL = /^\s*failed (.+) \([^()]*\)$/;
const SUMMARY = /^\s*(?:(?:Failed|Passed|Skipped)!\s+- Failed:|Test run summary:|(?:total|failed|succeeded|skipped|duration):\s)/;
const BUILD_ERROR = /: error [A-Z]+\d+:/;
const FRAME = /^\s*at /;
const USER_FRAME = / in .+:(?:line )?\d+$/;
const TRACE_NOISE = /^\s*-+ ?(End of stack trace|Inner Stack Trace)/;
const MAX_BLOCK = 25;
const MAX_FAILURES = 20;

/** Picks failed tests (VSTest and Microsoft.Testing.Platform formats), compiler errors and run summaries out of dotnet test output. */
export class DotnetTestDigest {
  private failures: string[][] = [];
  private block: string[] | null = null;
  private frames = 0;
  private errors = new Set<string>();
  private summary: string[] = [];

  push(line: string): void {
    if (VSTEST_FAIL.test(line) || MTP_FAIL.test(line)) {
      this.block = [line.trim()];
      this.frames = 0;
      this.failures.push(this.block);
    } else if (BUILD_ERROR.test(line)) {
      this.errors.add(line.trim());
      this.block = null;
    } else if (SUMMARY.test(line)) {
      this.summary.push(line.trim());
      this.block = null;
    } else if (this.block) {
      if (!line.trim()) this.block = null;
      else if (this.block.length >= MAX_BLOCK || TRACE_NOISE.test(line)) return;
      else if (!FRAME.test(line)) this.block.push(`  ${line.trim()}`);
      else if (USER_FRAME.test(line) && this.frames < 3) {
        this.block.push(`  ${line.trim()}`);
        this.frames++;
      }
    }
  }

  render(): string[] {
    const out: string[] = [];
    if (this.failures.length) {
      out.push(`-- failed tests (${this.failures.length})`);
      for (const b of this.failures.slice(0, MAX_FAILURES)) out.push(...b);
      if (this.failures.length > MAX_FAILURES) out.push(`(${this.failures.length - MAX_FAILURES} more failed tests in the full output)`);
    }
    if (this.errors.size) out.push(`-- build errors (${this.errors.size})`, ...[...this.errors].slice(0, 30));
    if (this.summary.length) out.push('-- summary', ...this.summary.slice(0, 30));
    return out.length ? out : ['-- dotnet test: no failed tests, build errors or summary found'];
  }
}

export interface DigestOptions {
  tail: number;
  match?: RegExp | undefined;
  contextAfter?: number | undefined;
  dotnetTest?: boolean | undefined;
}

/** Streams output lines once and keeps only what the result needs. */
export class OutputDigest {
  count = 0;
  private head: string[] = [];
  private tailBuf: string[] = [];
  private matches: string[] = [];
  private matchTotal = 0;
  private matchShown = 0;
  private after = 0;
  private dotnet: DotnetTestDigest | undefined;

  constructor(private opts: DigestOptions) {
    if (opts.dotnetTest) this.dotnet = new DotnetTestDigest();
  }

  push(raw: string): void {
    const line = clean(raw);
    this.count++;
    if (this.head.length <= FULL_OUTPUT_LINES) this.head.push(line);
    this.tailBuf.push(line);
    if (this.tailBuf.length > this.opts.tail) this.tailBuf.shift();
    this.dotnet?.push(line);
    if (!this.opts.match) return;
    if (this.opts.match.test(line)) {
      this.matchTotal++;
      if (this.matches.length < MAX_MATCHES) {
        this.matches.push(`${this.count}: ${line}`);
        this.matchShown++;
      }
      this.after = this.opts.contextAfter ?? 0;
    } else if (this.after > 0) {
      this.after--;
      if (this.matches.length < MAX_MATCHES) this.matches.push(`${this.count}- ${line}`);
    }
  }

  render(): string[] {
    if (this.count <= FULL_OUTPUT_LINES) return this.count ? ['-- output', ...this.head] : ['-- no output'];
    const out = this.dotnet ? this.dotnet.render() : [];
    if (this.opts.match) {
      out.push(`-- lines matching ${this.opts.match} (${this.matchTotal})`, ...this.matches);
      if (this.matchTotal > this.matchShown) out.push(`(${this.matchTotal - this.matchShown} more matches in the full output)`);
    }
    if (this.opts.tail > 0) out.push(`-- last ${this.tailBuf.length} lines`, ...this.tailBuf);
    return out;
  }
}
