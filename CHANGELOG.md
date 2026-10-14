# Changelog

All notable changes to Paste Ops are documented here.

## v0.3 - 2026-10-14

Changes since v0.1.

### Added

- MIT `LICENSE` file to remove packaging license warnings.
- Finalized `package.json` metadata for personal GitHub releases.
- `LLM_RULES.md` as a copy-paste prompt contract for LLMs.
- Expanded `README.md` with usage, operation format, safety, and context export docs.
- Selective apply with per-operation checkboxes.
- Select all / select none controls in the review panel.
- Operation grouping by affected file.
- Inline colored diff in the review panel.
- Native VS Code diff viewer through `Open Diff`.
- Dependency annotations between operations.
- Visual dependency warnings when a required earlier operation is unchecked.
- Apply-choice clipboard report before writing.
- Final applied clipboard report after successful writing.
- Separate `context.js` module for file context export.
- `Paste Ops: Copy Files as Context` command.
- Explorer right-click support for context export.
- `Ctrl+Alt+C` shortcut when the Explorer is focused.
- Folder expansion for selected folders.
- Per-file exclusion in the context preview.
- Character, estimated token, and byte metrics per file and total.
- Binary file export as `file-base64:` context blocks.
- Automatic longer fence selection for files containing backticks.
- Hunk-only inline diff rendering instead of whole-file inline diff.
- Direct patch-hunk preview using the operation's SEARCH/REPLACE data.
- Myers diff support for full-file changes when practical.
- Prefix/suffix fallback diff for very large or complex full-file rewrites.
- `changelog` metadata in `package.json`.

### Changed

- Review panel no longer accepts all or cancels all; operations can be applied selectively.
- Inline diff now shows only changed regions with a small amount of surrounding context.
- Large full-file diffs are collapsed in the inline preview while `Open Diff` still shows the full diff.
- Context selection now relies on the VS Code Explorer instead of a separate dropdown picker.
- `Ctrl+Alt+C` now reads the current Explorer selection, including a fallback for keyboard-only use.
- Clipboard behavior during apply now provides feedback to the LLM before and after execution.
- Documentation now describes the complete loop: LLM response -> review -> apply -> report -> context handoff.

### Removed

- Plain before/after text preview in the operation review panel.
- Redundant QuickPick dropdown file selector for context export.
- Artificial context size limits; users now see real metrics and decide.

### Fixed

- Missing license warning during `vsce package`.
- Context shortcut not recognizing Explorer selection in some cases.
- Inline diff becoming noisy for large files with small changes.