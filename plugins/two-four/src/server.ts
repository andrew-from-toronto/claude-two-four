import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { readCi } from './ci.js';
import { formatResult, runBatch } from './edit.js';
import { runCommand } from './run.js';
import { runSearch } from './search.js';

const EDIT_DESCRIPTION = `Create and edit files, across any number of files, in one call.

Entries apply in order, so later entries see earlier results, including several edits to one file. All or nothing: if any entry fails, no file is written and every failure is reported with the reason.

- Edit: old_string must match exactly once; set replace_all to replace every match. Curly vs straight quotes, dash variants, non-breaking spaces and CRLF vs LF are treated as equal when matching. Replacements keep the file's line endings.
- Create: omit old_string; new_string is the whole file. Fails if the file already exists.

Relative paths resolve against the project directory.`;

const editEntry = z.object({
  file_path: z.string().min(1).describe('Absolute path, or relative to the project directory'),
  old_string: z.string().optional().describe('Text to replace. Omit to create a new file'),
  new_string: z.string().describe('Replacement text, or the full content of a new file'),
  replace_all: z.boolean().optional().describe('Replace every match instead of requiring exactly one'),
});

const SEARCH_DESCRIPTION = `Search many files for several regex patterns in one call.

Every pattern runs against every file; results are grouped by pattern, then file, with line numbers (":" marks a match, "-" a context line). Patterns are JavaScript regex matched line by line; a leading (?i), (?m) or (?s) is accepted as a flag.

- paths: files, directories or globs (e.g. "src/**/*.cs"); default is the project directory. Directories in a git repo honour .gitignore; elsewhere .git, node_modules, bin and obj are skipped.
- include: filename globs to keep (e.g. "*.ts", "*.{cs,csproj}").
- Binary files and files over 8 MB are skipped.`;

const searchSpec = z.object({
  patterns: z.array(z.string().min(1)).min(1).describe('Regex patterns; each is reported separately'),
  paths: z.array(z.string().min(1)).optional().describe('Files, directories or globs; default the project directory'),
  include: z.array(z.string().min(1)).optional().describe('Filename globs to keep, e.g. "*.cs"'),
  ignore_case: z.boolean().optional().describe('Case-insensitive matching for all patterns'),
  context: z.number().int().min(0).max(20).optional().describe('Lines of context around each match (default 0)'),
  max_matches: z.number().int().min(1).optional().describe('Matches shown per pattern (default 200)'),
  files_only: z.boolean().optional().describe('List matching files with counts instead of lines'),
});

const RUN_DESCRIPTION = `Run a shell command, save its full output (stdout and stderr interleaved) to a file, and return a digest.

The result gives the exit code, duration, line count and the output file's path. Short output (60 lines or fewer) comes back whole. Longer output comes back as: the preset's findings, lines matching \`match\` (with \`context_after\` lines after each), then the last \`tail\` lines. Read or search the file for anything else.

- shell: pwsh (default on Windows) or bash (Git Bash on Windows). The exit code is the last command's, like bash.
- preset "dotnet-test": failed tests with their messages and first user-code stack frames, compiler errors, and run summaries; works for VSTest and Microsoft.Testing.Platform output.
- No stdin; interactive prompts will hang until the timeout, which kills the whole process tree. Cancelling the call kills it too.`;

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

For each run: status, job counts, failed jobs with their failed steps, and per failed step the ##[error] lines plus its last log_lines lines (up to 5 jobs, fetched in parallel). Returns immediately; poll again for in-progress runs.

- grep: search the job logs instead (regex, timestamps stripped; a leading (?i) is accepted), with context lines; up to 20 jobs.
- jobs: regex on job name to choose which jobs' logs to read, passed or failed (default: failed jobs).
- Each completed job's full log is cached and its path returned ("log: ..."); grep line numbers are that file's, so it can be read or searched directly.`;

const ciSpec = z.object({
  target: z.string().min(1).describe('Run/job/PR URL, run id, #PR, commit SHA or branch'),
  repo: z.string().optional().describe('owner/name; default the repo gh infers from the project directory or the URL'),
  log_lines: z.number().int().min(0).max(300).optional().describe('Last lines per failed step (default 30)'),
  grep: z.string().optional().describe('Regex to search the job logs for instead of the failed-step summary'),
  context: z.number().int().min(0).max(20).optional().describe('grep: lines of context around each match (default 0)'),
  max_matches: z.number().int().min(1).max(1000).optional().describe('grep: matches shown per job (default 50)'),
  jobs: z.string().optional().describe('Regex on job name selecting which jobs to read (default: failed jobs)'),
});

const baseDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

const handle = serveStdio(() => {
  const server = new McpServer({ name: 'two-four', version: '0.3.0' });
  server.registerTool(
    'edit',
    {
      description: EDIT_DESCRIPTION,
      inputSchema: z.object({ edits: z.array(editEntry).min(1).describe('Edits to apply in order') }),
    },
    async ({ edits }) => {
      const result = await runBatch(edits, baseDir);
      return { content: [{ type: 'text', text: formatResult(result, edits.length) }], isError: !result.ok };
    },
  );
  server.registerTool('search', { description: SEARCH_DESCRIPTION, inputSchema: searchSpec }, async (spec) => {
    const result = await runSearch(spec, baseDir);
    return { content: [{ type: 'text', text: result.text }], isError: !result.ok };
  });
  server.registerTool('run', { description: RUN_DESCRIPTION, inputSchema: runSpec }, async (spec, ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    const result = await runCommand(spec, baseDir, {
      signal: ctx.mcpReq.signal,
      // Keeps Claude Code's idle timeout from aborting quiet long runs, including backgrounded ones.
      onProgress:
        progressToken === undefined
          ? undefined
          : (progress, message) => void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress, message } }).catch(() => {}),
    });
    return { content: [{ type: 'text', text: result.text }], isError: !result.ok };
  });
  server.registerTool('ci', { description: CI_DESCRIPTION, inputSchema: ciSpec }, async (spec) => {
    const result = await readCi(spec, baseDir);
    return { content: [{ type: 'text', text: result.text }], isError: !result.ok };
  });
  return server;
});

process.on('SIGINT', () => void handle.close());
