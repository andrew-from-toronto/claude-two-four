import { describe, expect, it } from 'vitest';
import { DotnetTestDigest, OutputDigest } from '../src/digest.js';

const feed = (d: { push(l: string): void }, text: string) => text.split('\n').forEach((l) => d.push(l));

const VSTEST = `  Failed Demo.Tests.ParserTests.Parse_ReturnsNull [16 ms]
  Error Message:
   Assert.Null() Failure: Value of type 'Nullable<int>' has a value
Expected: null
Actual:   300
  Stack Trace:
     at Demo.Tests.ParserTests.Parse_ReturnsNull() in C:\\src\\demo\\ParserTests.cs:line 59
   at System.Reflection.MethodBaseInvoker.InterpretedInvoke_Method(Object obj, IntPtr* args)

Failed!  - Failed:     1, Passed:    31, Skipped:     0, Total:    32, Duration: 63 ms - Demo.Tests.dll (net10.0)`;

const MTP = `failed Demo.Tests.MailTests.Sends_once(x: "a b") (8s 985ms)
  from C:\\src\\demo\\Demo.Tests.dll (net10.0|x64)
  Xunit.MicrosoftTestingPlatform.XunitException: System.Net.Mail.SmtpException : Failure sending mail.
  ---- System.IO.IOException : Unable to read data from the transport connection.
    at System.Net.Mail.SmtpClient.SendAsyncInternal(MailMessage message)
    --- End of stack trace from previous location ---
    ----- Inner Stack Trace -----
    at Demo.Tests.MailTests.Sends_once() in C:\\src\\demo\\MailTests.cs:42
Test run summary: Failed!
  total: 10
  failed: 1
  succeeded: 9`;

const BUILD = `C:\\src\\demo\\Program.cs(21,39): error CS1061: 'Widget' does not contain 'Frob' [C:\\src\\demo\\Demo.csproj]
C:\\src\\demo\\Program.cs(21,39): warning CS0168: unused
C:\\src\\demo\\Program.cs(21,39): error CS1061: 'Widget' does not contain 'Frob' [C:\\src\\demo\\Demo.csproj]`;

describe('DotnetTestDigest', () => {
  it('extracts VSTest failures with message and user frame only', () => {
    const d = new DotnetTestDigest();
    feed(d, VSTEST);
    const out = d.render().join('\n');
    expect(out).toContain('-- failed tests (1)\nFailed Demo.Tests.ParserTests.Parse_ReturnsNull [16 ms]');
    expect(out).toContain('  Expected: null\n  Actual:   300');
    expect(out).toContain('ParserTests.cs:line 59');
    expect(out).not.toContain('MethodBaseInvoker');
    expect(out).toContain('-- summary\nFailed!  - Failed:     1');
  });

  it('extracts MTP failures including parameterised names and inner exceptions', () => {
    const d = new DotnetTestDigest();
    feed(d, MTP);
    const out = d.render().join('\n');
    expect(out).toContain('failed Demo.Tests.MailTests.Sends_once(x: "a b") (8s 985ms)');
    expect(out).toContain('  ---- System.IO.IOException');
    expect(out).toContain('MailTests.cs:42');
    expect(out).not.toContain('SendAsyncInternal');
    expect(out).not.toContain('End of stack trace');
    expect(out).toContain('Test run summary: Failed!\ntotal: 10\nfailed: 1\nsucceeded: 9');
  });

  it('dedupes compiler errors and ignores warnings', () => {
    const d = new DotnetTestDigest();
    feed(d, BUILD);
    const out = d.render();
    expect(out[0]).toBe('-- build errors (1)');
    expect(out.join('\n')).not.toContain('warning');
  });
});

describe('OutputDigest', () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');

  it('returns short output whole', () => {
    const d = new OutputDigest({ tail: 5, match: /x/ });
    feed(d, 'a\n\x1b[31mred\x1b[0m\nprogress 10%\rprogress 100%');
    expect(d.render()).toEqual(['-- output', 'a', 'red', 'progress 100%']);
  });

  it('counts only real matches when saying more exist', () => {
    const d = new OutputDigest({ tail: 0, match: /0$/, contextAfter: 9 });
    feed(d, long);
    const out = d.render();
    expect(out[0]).toBe('-- lines matching /0$/ (10)');
    expect(out.join('\n')).not.toContain('more matches');
  });

  it('returns matches with context and the tail for long output', () => {
    const d = new OutputDigest({ tail: 2, match: /^line 5$/, contextAfter: 1 });
    feed(d, long);
    expect(d.render()).toEqual(['-- lines matching /^line 5$/ (1)', '5: line 5', '6- line 6', '-- last 2 lines', 'line 99', 'line 100']);
  });
});
