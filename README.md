# claude-two-four

A case of Claude Code plugins.

## Install

```
/plugin marketplace add andrew-from-toronto/claude-two-four
/plugin install batch-edit@claude-two-four
/plugin install shell@claude-two-four
```

Needs Node 22 or later on the machine.

## Plugins

### batch-edit

One `edit` tool that creates and edits any number of files in a single call.

- Entries apply in order, so later edits see earlier ones, including several edits to the same file.
- All or nothing: if any entry fails, no file is written, and every failure comes back with its reason (plus the closest-matching lines when the search text isn't found).
- Search text must match exactly once unless `replace_all` is set. Curly vs straight quotes, dash variants, non-breaking spaces and CRLF vs LF count as equal when matching, and replacements keep the file's line endings.
- Omitting `old_string` creates a file (and its folders); it never overwrites an existing one.
- Writes go through symlinks and junctions to their targets instead of replacing the link.

And a `search` tool that runs several regex patterns over many files in one call.

- Paths can be files, directories or globs; directories in a git repo honour `.gitignore`.
- Results are grouped by pattern, then file, with line numbers and optional context.
- A leading `(?i)`, `(?m)` or `(?s)` is accepted as a flag, since JavaScript regex rejects it.
- Files that can't match are never split into lines, and reads run 64 at a time.

### shell

`run` runs a command (pwsh or bash), saves the full interleaved output to a file under the temp folder, and returns the exit code plus a digest: the whole output if short, otherwise matching lines and the tail.

- The `dotnet-test` preset returns failed tests with their messages and first user-code stack frames, compiler errors, and run summaries, for both VSTest and Microsoft.Testing.Platform.
- A timeout kills the whole process tree.

`ci` reads GitHub Actions results through the `gh` CLI.

- Takes a run or job URL, run id, PR (`#123` or URL), commit SHA (short ones are expanded) or branch.
- Shows the newest run per workflow, job counts, and for each failed step its `##[error]` lines and last log lines.
- Job logs are fetched per job and in parallel, then sliced to the failed step.

## Develop

In `plugins/batch-edit` or `plugins/shell`:

```
pnpm install
pnpm test
pnpm build
```

Each plugin runs its committed bundle `dist/server.mjs` as-is, so rebuild and commit it with every source change.