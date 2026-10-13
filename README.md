# Paste Ops

Paste Ops is a VS Code extension that converts an LLM response into safe, reviewed file operations.

Instead of manually creating files, you copy the LLM response and run Paste Ops. It parses special operation blocks, previews the changes, lets you select what to apply, and then writes only the approved changes.

## Features

- Creates files and folders
- Overwrites files with full-file blocks
- Applies exact `SEARCH/REPLACE` patches
- Renames/moves files and folders
- Deletes files and folders
- Skips invalid blocks instead of stopping the whole response
- Shows grouped operations by file
- Shows inline colored diff
- Can open VS Code's native diff viewer
- Lets you select/deselect operations
- Warns about dependencies between operations
- Dry-runs everything before writing
- Re-validates files before applying

## Supported blocks

### Full file

Creates or overwrites a file.

````text
```file:src/app.js
console.log("hello");
```
````

### Patch

Edits an existing file using exact SEARCH/REPLACE hunks.

````text
```patch:src/app.js
<<<<<<< SEARCH
old code
=======
new code
>>>>>>> REPLACE
```
````

### Rename

````text
```rename:src/old.js -> src/new.js
```
````

### Delete

````text
```delete:src/old.js
```
````

### Empty folder

````text
```dir:public/uploads/
```
````

## Install

### From GitHub release

Download the `.vsix` from the GitHub release page, then:

```bash
code --install-extension paste-ops.vsix --force
```

Or in VS Code:

```text
Extensions -> ... -> Install from VSIX...
```

### Build locally

```bash
npx --yes @vscode/vsce package -o paste-ops.vsix --allow-missing-repository
code --install-extension paste-ops.vsix --force
```

## Usage

1. Copy an LLM response.
2. Run command:

```text
Paste Ops: Apply File Operations from Clipboard
```

Default shortcut:

```text
Ctrl+Alt+V
Cmd+Alt+V
```

3. Review the preview.
4. Use `Open Diff` for detailed comparison.
5. Select or unselect operations.
6. Click `Apply`.

## LLM rules

For the best results, give the LLM the rules in:

```text
LLM_RULES.md
```

That file contains a prompt you can paste as the first message.

## Safety

Paste Ops:

- performs a dry run first
- shows a preview before writing
- skips invalid blocks
- refuses absolute paths
- refuses `..`
- refuses `.git`
- refuses symlink targets
- checks that files did not change during review

Still, use Git or backups before applying large changes.

## Development

Open this folder in VS Code and press `F5`.

Package:

```bash
npx --yes @vscode/vsce package -o paste-ops.vsix --allow-missing-repository
```
