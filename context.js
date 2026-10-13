"use strict";

const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");

function humanBytes(n) {
  if (!Number.isFinite(n)) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function chooseFence(text) {
  let len = 3;

  while (new RegExp("^`{" + len + ",}\\s*$", "m").test(text)) {
    len++;
  }

  return "`".repeat(len);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toUri(item) {
  if (!item) return null;

  if (vscode.Uri.isUri(item)) return item;

  if (item.resourceUri && vscode.Uri.isUri(item.resourceUri)) {
    return item.resourceUri;
  }

  if (item.uri && vscode.Uri.isUri(item.uri)) {
    return item.uri;
  }

  if (typeof item.fsPath === "string") {
    return vscode.Uri.file(item.fsPath);
  }

  if (typeof item.resource === "string") {
    return vscode.Uri.file(item.resource);
  }

  if (typeof item === "string") {
    return vscode.Uri.file(item);
  }

  return null;
}

async function focusExplorer() {
  try {
    await vscode.commands.executeCommand("workbench.explorer.fileView.focus");
    return;
  } catch {}

  try {
    await vscode.commands.executeCommand(
      "workbench.files.action.focusFilesExplorer"
    );
    return;
  } catch {}
}

async function attemptCopyPathCommand(command) {
  const oldClipboard = await vscode.env.clipboard.readText();
  const sentinel = `paste-ops-selection-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;

  await vscode.env.clipboard.writeText(sentinel);

  try {
    await vscode.commands.executeCommand(command);
  } catch {}

  let text = sentinel;

  for (let i = 0; i < 20; i++) {
    text = await vscode.env.clipboard.readText();

    if (text !== sentinel) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await vscode.env.clipboard.writeText(oldClipboard);

  if (text === sentinel) {
    return null;
  }

  return text;
}

function parseClipboardPaths(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((p) => vscode.Uri.file(p));
}

async function readSelectedPathsViaCopyPath() {
  const commands = [
    "copyFilePath",
    "workbench.action.files.copyPath",
  ];

  for (const command of commands) {
    const text = await attemptCopyPathCommand(command);

    if (text) {
      const uris = parseClipboardPaths(text);

      if (uris.length) {
        return uris;
      }
    }
  }

  return [];
}

async function getExplorerSelection() {
  try {
    await focusExplorer();
  } catch {}

  const uris = [];

  try {
    let items = await vscode.commands.executeCommand("list.getSelection");

    if (!Array.isArray(items) || items.length === 0) {
      const focused = await vscode.commands.executeCommand("list.getFocused");

      if (focused) {
        items = Array.isArray(focused) ? focused : [focused];
      }
    }

    if (Array.isArray(items)) {
      for (const item of items) {
        const uri = toUri(item);
        if (uri) uris.push(uri);
      }
    }
  } catch {}

  if (uris.length) {
    return uris;
  }

  try {
    return await readSelectedPathsViaCopyPath();
  } catch {
    return [];
  }
}

async function expandUris(uris) {
  const map = new Map();

  for (const uri of uris) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);

      if (stat.type === vscode.FileType.Directory) {
        const pattern = new vscode.RelativePattern(uri, "**/*");
        const files = await vscode.workspace.findFiles(pattern);

        for (const file of files) {
          map.set(file.toString(), file);
        }
      } else if (stat.type === vscode.FileType.File) {
        map.set(uri.toString(), uri);
      }
    } catch {
      // Ignore unreadable items during expansion.
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const ra = vscode.workspace.asRelativePath(a, false);
    const rb = vscode.workspace.asRelativePath(b, false);
    return ra.localeCompare(rb);
  });
}

async function loadEntries(uris) {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Paste Ops: reading selected files",
    },
    async (progress) => {
      const entries = [];

      for (let i = 0; i < uris.length; i++) {
        const uri = uris[i];
        const rel = vscode.workspace
          .asRelativePath(uri, false)
          .replace(/\\/g, "/");

        progress.report({
          message: rel,
          increment: uris.length ? 100 / uris.length : 100,
        });

        try {
          const openDoc = vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === uri.toString() && !d.isUntitled
          );

          let text = null;
          let base64 = null;
          let isBinary = false;
          let bytes = 0;

          if (openDoc) {
            text = openDoc.getText();
            bytes = Buffer.byteLength(text, "utf8");
          } else {
            const stat = await vscode.workspace.fs.stat(uri);
            const buffer = Buffer.from(await vscode.workspace.fs.readFile(uri));

            bytes = stat.size;

            if (buffer.includes(0)) {
              isBinary = true;
              base64 = buffer.toString("base64");
            } else {
              text = buffer.toString("utf8");
            }
          }

          const chars = isBinary ? base64.length : text.length;
          const tokens = Math.ceil(chars / 4);

          entries.push({
            rel,
            uri,
            isBinary,
            text,
            base64,
            chars,
            tokens,
            bytes,
            error: null,
          });
        } catch (e) {
          entries.push({
            rel,
            uri,
            isBinary: false,
            text: null,
            base64: null,
            chars: 0,
            tokens: 0,
            bytes: 0,
            error: e.message,
          });
        }
      }

      return entries;
    }
  );
}

function contextPreviewHtml(entries, nonce) {
  const rows = entries
    .map((entry, index) => {
      const disabled = entry.error ? "disabled" : "";
      const checked = entry.error ? "" : "checked";
      const type = entry.error ? "error" : entry.isBinary ? "base64" : "text";
      const title = entry.error ? escapeHtml(entry.error) : "";

      return `
        <tr class="file-row" data-index="${index}"
            data-path="${escapeHtml(entry.rel.toLowerCase())}"
            data-chars="${entry.chars}"
            data-tokens="${entry.tokens}"
            data-bytes="${entry.bytes}">
          <td><input type="checkbox" class="file-check" data-index="${index}" ${checked} ${disabled}></td>
          <td><code title="${title}">${escapeHtml(entry.rel)}</code></td>
          <td class="num">${entry.chars.toLocaleString()}</td>
          <td class="num">~${entry.tokens.toLocaleString()}</td>
          <td class="num">${humanBytes(entry.bytes)}</td>
          <td>${type}</td>
        </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
  h1 { font-size: 20px; margin-top: 0; }

  .toolbar { display: flex; gap: 8px; margin: 12px 0; align-items: center; flex-wrap: wrap; }

  input[type="text"] {
    padding: 6px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-widget-border, #444);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    min-width: 280px;
  }

  table { border-collapse: collapse; width: 100%; margin-top: 10px; }
  th, td { border-bottom: 1px solid var(--vscode-widget-border, #333); padding: 6px 8px; font-size: 13px; }
  th { text-align: left; opacity: .8; position: sticky; top: 0; background: var(--vscode-editor-background); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }

  code { font-family: var(--vscode-editor-font-family); }

  .hidden { display: none; }

  .totals { margin: 12px 0; padding: 10px 12px;
            background: var(--vscode-textBlockQuote-background); border-radius: 6px; }

  .footer { position: sticky; bottom: 0; padding-top: 16px;
            display: flex; gap: 10px; align-items: center; }

  button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }

  button:disabled { opacity: .5; cursor: not-allowed; }

  .hint { opacity: .6; font-size: 12px; }
</style>
</head>
<body>
  <h1>Paste Ops — Copy Files as Context</h1>
  <div class="hint">
    Uncheck files you do not want. Token counts are estimates.
  </div>

  <div class="toolbar">
    <input id="filter" type="text" placeholder="Filter files...">
    <button id="select-all-visible" class="secondary">Select visible</button>
    <button id="select-none-visible" class="secondary">Unselect visible</button>
  </div>

  <div class="totals">
    <div id="total-files">Files: 0</div>
    <div id="total-chars">Characters: 0</div>
    <div id="total-tokens">Estimated tokens: ~0</div>
    <div id="total-bytes">Bytes: 0 B</div>
  </div>

  <table>
    <thead>
      <tr>
        <th></th>
        <th>File</th>
        <th class="num">Chars</th>
        <th class="num">Est. tokens</th>
        <th class="num">Size</th>
        <th>Type</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <div class="footer">
    <button id="copy">Copy selected file blocks</button>
    <button id="cancel" class="secondary">Cancel</button>
    <span class="hint">Copied output uses file: blocks with relative paths.</span>
  </div>

<script nonce="${nonce}">
  const api = acquireVsCodeApi();

  const copyBtn = document.getElementById("copy");
  const cancelBtn = document.getElementById("cancel");
  const filterInput = document.getElementById("filter");
  const selectAllVisible = document.getElementById("select-all-visible");
  const selectNoneVisible = document.getElementById("select-none-visible");

  const totalFiles = document.getElementById("total-files");
  const totalChars = document.getElementById("total-chars");
  const totalTokens = document.getElementById("total-tokens");
  const totalBytes = document.getElementById("total-bytes");

  function allRows() {
    return Array.from(document.querySelectorAll(".file-row"));
  }

  function visibleRows() {
    return allRows().filter((row) => !row.classList.contains("hidden"));
  }

  function updateTotals() {
    let files = 0;
    let chars = 0;
    let tokens = 0;
    let bytes = 0;

    document.querySelectorAll(".file-check").forEach((check) => {
      if (!check.checked) return;

      const row = check.closest("tr");

      files++;
      chars += Number(row.dataset.chars || 0);
      tokens += Number(row.dataset.tokens || 0);
      bytes += Number(row.dataset.bytes || 0);
    });

    totalFiles.textContent = "Files: " + files.toLocaleString();
    totalChars.textContent = "Characters: " + chars.toLocaleString();
    totalTokens.textContent = "Estimated tokens: ~" + tokens.toLocaleString();
    totalBytes.textContent = "Bytes: " + bytes.toLocaleString();

    copyBtn.disabled = files === 0;
    copyBtn.textContent = "Copy " + files + " file block(s)";
  }

  function applyFilter() {
    const q = filterInput.value.trim().toLowerCase();

    allRows().forEach((row) => {
      const p = row.dataset.path || "";
      row.classList.toggle("hidden", q.length > 0 && p.indexOf(q) === -1);
    });

    updateTotals();
  }

  filterInput.addEventListener("input", applyFilter);

  selectAllVisible.onclick = () => {
    visibleRows().forEach((row) => {
      const check = row.querySelector(".file-check");
      if (check && !check.disabled) check.checked = true;
    });
    updateTotals();
  };

  selectNoneVisible.onclick = () => {
    visibleRows().forEach((row) => {
      const check = row.querySelector(".file-check");
      if (check && !check.disabled) check.checked = false;
    });
    updateTotals();
  };

  copyBtn.onclick = () => {
    const selected = Array.from(document.querySelectorAll(".file-check:checked"))
      .map((check) => Number(check.dataset.index));

    api.postMessage({ command: "copy", selected: selected });
  };

  cancelBtn.onclick = () => {
    api.postMessage({ command: "cancel" });
  };

  updateTotals();
</script>
</body>
</html>`;
}

function showContextPreview(entries) {
  return new Promise((resolve) => {
    let settled = false;

    const panel = vscode.window.createWebviewPanel(
      "pasteOpsContextPreview",
      "Paste Ops — Context Files",
      vscode.ViewColumn.Active,
      { enableScripts: true }
    );

    const nonce = crypto.randomBytes(16).toString("hex");
    panel.webview.html = contextPreviewHtml(entries, nonce);

    function finish(value) {
      if (settled) return;
      settled = true;
      resolve(value);
      panel.dispose();
    }

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "copy") {
        finish(Array.isArray(msg.selected) ? msg.selected : []);
      } else if (msg.command === "cancel") {
        finish(null);
      }
    });

    panel.onDidDispose(() => finish(null));
  });
}

function buildContextText(entries, selectedIndexes) {
  const sorted = Array.from(new Set(selectedIndexes)).sort((a, b) => a - b);
  const blocks = [];

  for (const index of sorted) {
    const entry = entries[index];

    if (!entry || entry.error) continue;

    const content = entry.isBinary ? entry.base64 : entry.text;
    const fence = chooseFence(content);
    const kind = entry.isBinary ? "file-base64" : "file";

    blocks.push(`${fence}${kind}:${entry.rel}\n${content}\n${fence}`);
  }

  return blocks.join("\n\n") + "\n";
}

async function copyFilesAsContext(uri, uris) {
  try {
    const folders = vscode.workspace.workspaceFolders;

    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage("Open a workspace folder first.");
      return;
    }

    let initial = [];

    if (Array.isArray(uris) && uris.length > 0) {
      initial = uris;
    } else if (uri) {
      initial = [uri];
    } else {
      initial = await getExplorerSelection();
    }

    if (!initial.length) {
      vscode.window.showWarningMessage(
        "Select files/folders in the VS Code Explorer first, then run Paste Ops: Copy Files as Context."
      );
      return;
    }

    const expanded = await expandUris(initial);

    if (!expanded.length) {
      vscode.window.showWarningMessage("No files found for the selected items.");
      return;
    }

    const entries = await loadEntries(expanded);

    if (!entries.length) {
      vscode.window.showWarningMessage("No readable files found.");
      return;
    }

    const selected = await showContextPreview(entries);

    if (!selected || selected.length === 0) return;

    const text = buildContextText(entries, selected);

    await vscode.env.clipboard.writeText(text);

    const selectedEntries = selected
      .map((i) => entries[i])
      .filter((e) => e && !e.error);

    const totalChars = selectedEntries.reduce((sum, e) => sum + e.chars, 0);
    const totalTokens = selectedEntries.reduce((sum, e) => sum + e.tokens, 0);
    const totalBytes = selectedEntries.reduce((sum, e) => sum + e.bytes, 0);

    vscode.window.showInformationMessage(
      `Paste Ops: copied ${selectedEntries.length} file(s), ` +
        `${totalChars.toLocaleString()} chars, ` +
        `~${totalTokens.toLocaleString()} tokens, ` +
        `${humanBytes(totalBytes)}.`
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Paste Ops context copy failed: ${e.message}`);
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pasteOps.copyFilesAsContext",
      copyFilesAsContext
    )
  );
}

module.exports = { activate };