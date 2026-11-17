# claude-two-four

A case of Claude Code plugins.

## Install

```
/plugin marketplace add andrew-from-toronto/claude-two-four
/plugin install batch-edit@claude-two-four
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

## Develop

```
cd plugins/batch-edit
pnpm install
pnpm test
pnpm build
```

The plugin runs the committed bundle `dist/server.mjs` as-is, so rebuild and commit it with every source change.