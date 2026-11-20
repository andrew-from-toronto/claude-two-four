import { describe, expect, it } from 'vitest';
import { condenseLog, grepLog, parseTarget } from '../src/ci.js';

describe('parseTarget', () => {
  it.each([
    ['https://github.com/o/r/actions/runs/1234567890/job/9876543210', { kind: 'run', repo: 'o/r', id: '1234567890', job: '9876543210' }],
    ['https://github.com/o/r/actions/runs/1234567890', { kind: 'run', repo: 'o/r', id: '1234567890', job: undefined }],
    ['https://github.com/o/r/pull/42', { kind: 'pr', repo: 'o/r', number: '42' }],
    ['#12', { kind: 'pr', number: '12' }],
    ['pr:12', { kind: 'pr', number: '12' }],
    ['42', { kind: 'pr', number: '42' }],
    ['1234567890', { kind: 'run', id: '1234567890' }],
    ['ABCDEF12', { kind: 'sha', sha: 'abcdef12' }],
    ['feature/new-thing', { kind: 'branch', name: 'feature/new-thing' }],
  ])('%s', (raw, expected) => {
    expect(parseTarget(raw)).toEqual(expected);
  });
});

describe('condenseLog', () => {
  const log = [
    '﻿2026-01-01T00:00:05.0000000Z Checkout done',
    '2026-01-01T00:00:10.0000000Z ##[group]Run dotnet build',
    '2026-01-01T00:00:11.1000000Z Restore complete',
    '2026-01-01T00:00:11.6000000Z ##[error]Program.cs(21,39): error CS1061: nope',
    'continuation without timestamp',
    '2026-01-01T00:00:11.6500000Z Build FAILED.',
    '2026-01-01T00:00:11.6900000Z ##[error]Program.cs(21,39): error CS1061: nope',
    '2026-01-01T00:00:11.7000000Z ##[endgroup]',
    '2026-01-01T00:00:11.8000000Z next step starting in the same second',
    '2026-01-01T00:00:20.0000000Z Cleaning up orphan processes',
  ].join('\n');
  const steps = [
    { name: 'Checkout', conclusion: 'success', startedAt: '2026-01-01T00:00:01Z', completedAt: '2026-01-01T00:00:06Z' },
    { name: 'Build', conclusion: 'failure', startedAt: '2026-01-01T00:00:10Z', completedAt: '2026-01-01T00:00:11Z' },
  ];

  it('slices to the failed step, dedupes errors and strips timestamps and group markers', () => {
    expect(condenseLog(log, steps, 3)).toEqual([
      '    step: Build',
      '      errors:',
      '        Program.cs(21,39): error CS1061: nope',
      '      last 3 lines:',
      '        continuation without timestamp',
      '        Build FAILED.',
      '        ##[error]Program.cs(21,39): error CS1061: nope',
    ]);
  });

  it('greps with file line numbers, stripped timestamps, context and a cap', () => {
    expect(grepLog(log, /error CS/, 1, 1)).toEqual([
      '    2 matching lines',
      '      3- Restore complete',
      '      4: ##[error]Program.cs(21,39): error CS1061: nope',
      '      5- continuation without timestamp',
      '    (1 more; search the log file)',
    ]);
  });

  it('falls back to the whole job when steps have no times', () => {
    expect(condenseLog(log, [], 1)).toEqual(['    step: (whole job)', '      errors:', '        Program.cs(21,39): error CS1061: nope', '      last 1 lines:', '        Cleaning up orphan processes']);
  });
});
