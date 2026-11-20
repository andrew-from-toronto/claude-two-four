import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { formatResult, runBatch } from './edit.js';
import { runSearch } from './search.js';

const DESCRIPTION = `Create and edit files, across any number of files, in one call.

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

const baseDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

const handle = serveStdio(() => {
  const server = new McpServer({ name: 'batch-edit', version: '0.2.1' });
  server.registerTool(
    'edit',
    {
      description: DESCRIPTION,
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
  return server;
});

process.on('SIGINT', () => void handle.close());