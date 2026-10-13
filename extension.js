"use strict";

const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");
const {
  parseClipboard,
  execute,
  executeTolerant,
  memoryBackend,
  diskBackend,
  preflight,
} = require("./core");

let output;

function log(text) {
  if (!output) output = vscode.window.createOutputChannel("Paste Ops");
  output.appendLine(text);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function previewHtml(logItems, errors, nonce) {
  const destructive = logItems.some((x) => ["delete", "rmdir", "write"].includes(x.kind));

  const items = logItems
    .map((item, n) => {
      const label =
        item.kind === "rename" ? `${item.from} → ${item.to}` : item.path;

      let detail = "";
      if (item.after !== undefined) {
        const before = item.before === null ? "(file did not exist)" : item.before;
        detail = `
          <details>
            <summary>Review content</summary>
            <h4>Before</h4><pre>${escapeHtml(String(before).slice(0, 20000))}</pre>
            <h4>After</h4><pre>${escapeHtml(String(item.after).slice(0, 20000))}</pre>
          </details>`;
      }

      const meta = item.hunks ? `${item.hunks} hunk(s)` : "";

      return `
        <div class="op">
          <div class="row">
            <span class="step">${n + 1}</span>
            <span class="badge ${item.kind}">${item.kind.toUpperCase()}</span>
            <code>${escapeHtml(label)}</code>
            <span class="meta">${meta}</span>
          </div>
          ${detail}
        </div>`;
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
  .warn { padding: 10px 12px; border-left: 3px solid #dca342;
          background: var(--vscode-textBlockQuote-background); margin: 12px 0; }
  .errors { border-left: 3px solid #c33; background: var(--vscode-textBlockQuote-background);
            padding: 10px 12px; margin: 12px 0; }
  .errors ul { margin: 6px 0 0 18px; padding: 0; }
  .op { border: 1px solid var(--vscode-widget-border, #444);
        border-radius: 6px; margin: 10px 0; padding: 10px 12px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .step { opacity: .5; font-size: 12px; }
  .badge { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 4px;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.delete, .badge.rmdir { background: #a33; color: #fff; }
  .badge.rename { background: #369; color: #fff; }
  code { font-family: var(--vscode-editor-font-family); }
  .meta { opacity: .6; font-size: 12px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; opacity: .8; font-size: 12px; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px;
        background: var(--vscode-textBlockQuote-background); padding: 10px;
        border-radius: 4px; max-height: 320px; overflow: auto; }
  h4 { margin: 12px 0 4px; font-size: 12px; opacity: .7; }
  .footer { position: sticky; bottom: 0; padding-top: 16px;
            display: flex; gap: 10px; align-items: center; }
  button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }
  .hint { opacity: .6; font-size: 12px; }
</style>
</head>
<body>
  <h1>Paste Ops — review before applying</h1>
  <div class="hint">${logItems.length} valid operation(s), applied strictly in this order.</div>

  ${
    destructive
      ? `<div class="warn">This includes overwrites or deletions. Review carefully. Use Git if you want an easy rollback.</div>`
      : ""
  }

  ${
    errors.length
      ? `<div class="errors">
           <strong>Skipped invalid block(s)</strong>
           <ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
         </div>`
      : ""
  }

  ${items}

  <div class="footer">
    <button id="apply">Apply ${logItems.length} operation(s)</button>
    <button id="cancel" class="secondary">Cancel</button>
    <span class="hint">Nothing has been written to disk yet.</span>
  </div>

<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  document.getElementById("apply").onclick = () => api.postMessage({ command: "apply" });
  document.getElementById("cancel").onclick = () => api.postMessage({ command: "cancel" });
</script>
</body>
</html>`;
}

function showPreview(logItems, errors = []) {
  return new Promise((resolve) => {
    let settled = false;

    const panel = vscode.window.createWebviewPanel(
      "pasteOpsPreview",
      "Paste Ops — Review",
      vscode.ViewColumn.Active,
      { enableScripts: true }
    );

    const nonce = crypto.randomBytes(16).toString("hex");
    panel.webview.html = previewHtml(logItems, errors, nonce);

    function finish(value) {
      if (settled) return;
      settled = true;
      resolve(value);
      panel.dispose();
    }

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "apply") finish(true);
      if (msg.command === "cancel") finish(false);
    });

    panel.onDidDispose(() => finish(false));
  });
}

async function chooseRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length) return folders[0].uri.fsPath;

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Apply operations to this folder",
  });

  return picked && picked[0] ? picked[0].fsPath : undefined;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("pasteOps.apply", async () => {
      let root;

      try {
        const text = await vscode.env.clipboard.readText();

        if (!text.trim()) {
          vscode.window.showWarningMessage("Clipboard is empty.");
          return;
        }

        root = await chooseRoot();
        if (!root) return;
        root = path.resolve(root);

        const parsed = parseClipboard(text);
        const errors = [...parsed.parseErrors];

        if (!parsed.ops.length) {
          const message = errors.length
            ? `No valid operations. ${errors.length} block(s) skipped.`
            : "No file: / patch: / rename: / delete: / dir: blocks found.";

          if (errors.length) {
            log("Errors:");
            errors.forEach((e) => log(" - " + e));

            vscode.window
              .showErrorMessage(message, "Show Output")
              .then((choice) => {
                if (choice === "Show Output") {
                  if (!output) output = vscode.window.createOutputChannel("Paste Ops");
                  output.show(true);
                }
              });
          } else {
            vscode.window.showWarningMessage(message);
          }

          return;
        }

        const backend = memoryBackend(root);
        const plan = executeTolerant(parsed.ops, backend);

        errors.push(...plan.errors);

        if (!plan.validOps.length) {
          log("No valid operations after dry run.");
          errors.forEach((e) => log(" - " + e));

          vscode.window
            .showErrorMessage(
              `No valid operations. ${errors.length} block(s) skipped.`,
              "Show Output"
            )
            .then((choice) => {
              if (choice === "Show Output") {
                if (!output) output = vscode.window.createOutputChannel("Paste Ops");
                output.show(true);
              }
            });

          return;
        }

        log(
          `\n=== Dry run: ${plan.validOps.length} valid, ${errors.length} skipped ===`
        );

        for (const item of plan.log) {
          log(
            `${item.index + 1}. ${item.kind} ` +
              (item.kind === "rename" ? `${item.from} -> ${item.to}` : item.path)
          );
        }

        for (const e of errors) {
          log("SKIPPED: " + e);
        }

        const approved = await showPreview(plan.log, errors);

        if (!approved) {
          vscode.window.showInformationMessage("Cancelled. Nothing was written.");
          return;
        }

        preflight(root, backend.snapshot);

        execute(plan.validOps, diskBackend(root));

        log(
          `Applied ${plan.validOps.length} operation(s), skipped ${errors.length}.`
        );

        vscode.window.showInformationMessage(
          `Paste Ops: applied ${plan.validOps.length}, skipped ${errors.length}.`
        );
      } catch (e) {
        log("ERROR: " + e.message);

        vscode.window
          .showErrorMessage(`Paste Ops: ${e.message}`, "Show Output")
          .then((choice) => {
            if (choice === "Show Output") {
              if (!output) output = vscode.window.createOutputChannel("Paste Ops");
              output.show(true);
            }
          });
      }
    })
  );
}

module.exports = { activate };