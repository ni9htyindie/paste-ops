# Paste Ops

Paste Ops turns LLM responses into reviewed filesystem changes.

Copy an LLM response, run Paste Ops, review operations, select what to apply, then apply. It can also export selected workspace files as LLM context using the same `file:` block format.

## Features

- Parses only `file:`, `patch:`, `rename:`, `delete:`, and `dir:` blocks.
- Ignores normal prose and ordinary code blocks.
- Skips invalid blocks instead of aborting the whole response.
- Dry-runs all operations before writing.
- Shows a review panel before anything is written.
- Lets you select or unselect individual operations.
- Groups operations by affected file.
- Shows inline colored diff for changed hunks only.
- Opens VS Code's native diff viewer for full comparison.
- Warns when an operation depends on another unchecked operation.
- Copies an apply-choice report to clipboard before applying.
- Copies a final applied report to clipboard after successful apply.
- Exports selected Explorer files/folders as context blocks.
- Shows character, estimated token, and byte metrics before copying context.
- Handles binary files in context export as `file-base64:` blocks.
- Automatically chooses longer fences when file content contains backticks.
- Refuses unsafe paths, absolute paths, `..`, `.git`, and symlink targets.

## Commands

| Command | Default shortcut | Description |
| --- | --- | --- |
| `Paste Ops: Apply File Operations from Clipboard` | `Ctrl+Alt+V` / `Cmd+Alt+V` | Parse clipboard and apply selected file operations. |
| `Paste Ops: Copy Files as Context` | `Ctrl+Alt+C` when Explorer is focused | Export selected Explorer files/folders as `file:` context blocks. |

You can also use the Explorer right-click menu:

```text
Paste Ops: Copy Files as Context
```

## Supported operation blocks

### Create or overwrite a file

```file:src/app.js
console.log("hello");
```

### Patch an existing file

```patch:src/app.js
<<<<<<< SEARCH
old code
=======
new code
>>>>>>> REPLACE
```

### Rename or move

```rename:src/old.js -> src/new.js
```

### Delete

```delete:src/old.js
```

### Create empty folder

```dir:public/uploads/
```

### Binary context blocks

Context export may produce:

```file-base64:assets/icon.png
iVBORw0KGgo...
```

This version uses `file-base64:` for context only. The apply command does not execute `file-base64:` blocks.

## Apply reports

When you click Apply, Paste Ops first copies your selection to the clipboard. If the apply succeeds, the clipboard is replaced with the final applied report.

Example:

```paste-ops-report
state: applied
workspace: my-project

selected:
- #1 file src/app.js
- #3 patch src/lib/util.js

unselected:
- #2 delete tmp/log.txt

skipped-invalid:
- none
```

Paste this report back into the LLM chat so it knows what was actually applied.

## Context export

Select files or folders in the VS Code Explorer, then run:

```text
Paste Ops: Copy Files as Context
```

The preview shows:

- selected files
- characters
- estimated tokens
- bytes
- per-file and total metrics

There is no artificial size limit. You decide what is too large.

Binary files are included as base64. You can uncheck any file before copying.

The copied output uses relative paths and `file:` blocks, ready to paste into an LLM chat or a context document.

## LLM rules

Give the LLM the rules in:

```text
LLM_RULES.md
```

That file explains how to write responses for Paste Ops and how to interpret Paste Ops reports.

## Safety

Paste Ops:

- performs a dry run first
- shows a preview before writing
- re-validates selected operations before applying
- checks that files did not change while you were reviewing
- skips invalid blocks
- refuses absolute paths
- refuses `..`
- refuses `.git`
- refuses symlink targets

Still use Git or backups before applying large changes.

## Development

Open this folder in VS Code and press `F5`.

Package locally:

```bash
npx --yes @vscode/vsce package -o paste-ops.vsix --allow-missing-repository
code --install-extension paste-ops.vsix --force
```

## Changelog

See `CHANGELOG.md`.