import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { formatResult, runBatch } from './edit.js';

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

const baseDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

const handle = serveStdio(() => {
  const server = new McpServer({ name: 'batch-edit', version: '0.1.0' });
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
  return server;
});

process.on('SIGINT', () => void handle.close());