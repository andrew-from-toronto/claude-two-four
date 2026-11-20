import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { readCi } from './ci.js';
import { runCommand } from './run.js';

const RUN_DESCRIPTION = `Run a shell command, save its full output (stdout and stderr interleaved) to a file, and return a digest.

The result gives the exit code, duration, line count and the output file's path. Short output (60 lines or fewer) comes back whole. Longer output comes back as: the preset's findings, lines matching \`match\` (with \`context_after\` lines after each), then the last \`tail\` lines. Read or search the file for anything else.

- shell: pwsh (default on Windows) or bash (Git Bash on Windows). The exit code is the last command's, like bash.
- preset "dotnet-test": failed tests with their messages and first user-code stack frames, compiler errors, and run summaries; works for VSTest and Microsoft.Testing.Platform output.
- No stdin; interactive prompts will hang until the timeout, which kills the whole process tree.`;

const runSpec = z.object({
  command: z.string().min(1).describe('Script to run; may span several lines'),
  shell: z.enum(['pwsh', 'bash']).optional().describe('Default pwsh on Windows, bash elsewhere'),
  cwd: z.string().optional().describe('Working directory; default the project directory'),
  timeout_seconds: z.number().int().min(1).max(3600).optional().describe('Default 600'),
  match: z.string().optional().describe('Regex; matching lines are returned. A leading (?i) is accepted'),
  context_after: z.number().int().min(0).max(50).optional().describe('Lines kept after each match'),
  tail: z.number().int().min(0).max(500).optional().describe('Last lines returned (default 30)'),
  preset: z.enum(['dotnet-test']).optional().describe('Built-in digest for known tools'),
});

const CI_DESCRIPTION = `Read GitHub Actions results through the gh CLI, returning the failing steps' logs condensed.

target can be: a run URL or job URL; a run id (6+ digits); a PR as "#123", "pr:123", a bare small number or a PR URL; a commit SHA (short SHAs are expanded); or a branch name. For a PR, commit or branch it shows the newest run of each workflow.

For each run: status, job counts, failed jobs with their failed steps, and per failed step the ##[error] lines plus its last log_lines lines (up to 5 jobs, fetched in parallel). Returns immediately; poll again for in-progress runs.`;

const ciSpec = z.object({
  target: z.string().min(1).describe('Run/job/PR URL, run id, #PR, commit SHA or branch'),
  repo: z.string().optional().describe('owner/name; default the repo gh infers from the project directory or the URL'),
  log_lines: z.number().int().min(0).max(300).optional().describe('Last lines per failed step (default 30)'),
});

const baseDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

const handle = serveStdio(() => {
  const server = new McpServer({ name: 'shell', version: '0.1.0' });
  server.registerTool('run', { description: RUN_DESCRIPTION, inputSchema: runSpec }, async (spec) => {
    const result = await runCommand(spec, baseDir);
    return { content: [{ type: 'text', text: result.text }], isError: !result.ok };
  });
  server.registerTool('ci', { description: CI_DESCRIPTION, inputSchema: ciSpec }, async (spec) => {
    const result = await readCi(spec, baseDir);
    return { content: [{ type: 'text', text: result.text }], isError: !result.ok };
  });
  return server;
});

process.on('SIGINT', () => void handle.close());
