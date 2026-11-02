# File Operation Rules

## Unified Syntax

Every filesystem operation uses a single code block format:
The parser detects operation type automatically from the first line.

## Operation Types

### Create/Write File

`````
```
path/to/file.ext
file content here
```
`````
OR
`````
```path/to/file.ext
file content here
```
`````
The same rule apply for other operation.

- Relative paths only, forward slashes
- Parent folders created automatically
- Overwrites if file exists

### Patch File (Edit)

`````
```
path/to/file.ext
<<<<<<< SEARCH
exact current lines
=======
replacement lines
>>>>>>> REPLACE
```
`````

- SEARCH must match exactly once
- Include enough context for uniqueness
- Multiple SEARCH/REPLACE blocks allowed in one operation

### Rename/Move

`````
```
old/path.ext -> new/path.ext
```
`````

- Target must not exist
- Rename before patching new path

### Delete

`````
```
path/to/file-or-folder -> delete
```
`````

- Deletes file or folder recursively

### Create Empty Folder

`````
```
path/to/folder/
```
`````

- Must end with `/`
- No content
- Usually unnecessary (file operations create parents)

## Rules

- Relative paths only (no `/`, `..`, `.git`, absolute paths)
- Forward slashes only
- Apply operations in written order
- No whitespace in paths (except around `->` for rename/delete)
- Files containing ` ``` ` need longer outer fences

## Valid Examples

`````
```
src/config.json
{
  "debug": true
}
```

```
src/main.js
<<<<<<< SEARCH
const debug = false;
=======
const debug = true;
>>>>>>> REPLACE
```

```
src/old.js -> src/new.js
```

```
tmp/cache -> delete
```

```
public/uploads/
```
`````

## If File Contains Triple Backticks

Use longer outer fence:

`````
````
docs/example.md
Example:

```js
console.log(1);
```
````
`````

## Patch Rules

- SEARCH must match current file exactly
- SEARCH must match exactly once
- Include surrounding context
- No ellipses (`// ... existing code ...`)
- No line numbers alone
- If unsure, write full file instead

## Reading Feedback

When given `paste-ops-report`:

- `selected` = applied
- `unselected` = rejected by user
- `skipped-invalid` = failed validation

Fix exact structural mistakes from `skipped-invalid` and re-emit only corrected operations.

## Recovery

If unsure about syntax:

1. Use minimal examples above
2. Ask for one known-good example
3. Ask for `paste-ops-report` from previous apply

Never guess syntax.