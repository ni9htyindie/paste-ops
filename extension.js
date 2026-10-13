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
const diffStore = new Map();

function ensureOutput() {
  if (!output) output = vscode.window.createOutputChannel("Paste Ops");
  return output;
}

function log(text) {
  ensureOutput().appendLine(text);
}

function showOutput() {
  ensureOutput().show(true);
}

function fail(message, lines = []) {
  log("ERROR: " + message);
  lines.forEach((line) => log(" - " + line));

  vscode.window
    .showErrorMessage(message, "Show Output")
    .then((choice) => {
      if (choice === "Show Output") showOutput();
    });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openDiff(item) {
  const id = crypto.randomBytes(8).toString("hex");
  const label =
    item.kind === "rename"
      ? `${item.from} -> ${item.to}`
      : item.path || "change";

  const before =
    item.before === null || item.before === undefined
      ? ""
      : String(item.before);

  const after =
    item.after === null || item.after === undefined
      ? ""
      : String(item.after);

  diffStore.set(`/before/${id}`, before);
  diffStore.set(`/after/${id}`, after);

  while (diffStore.size > 200) {
    const first = diffStore.keys().next().value;
    diffStore.delete(first);
  }

  const left = vscode.Uri.parse(`pasteops-diff:/before/${id}`);
  const right = vscode.Uri.parse(`pasteops-diff:/after/${id}`);

  vscode.commands.executeCommand("vscode.diff", left, right, `${label} — Paste Ops`);
}

function previewHtml(logItems, errors, nonce) {
  const destructive = logItems.some((x) =>
    ["delete", "rmdir", "write"].includes(x.kind)
  );

  const items = logItems
    .map((item, n) => {
      const label =
        item.kind === "rename"
          ? `${item.from} → ${item.to}`
          : item.path || "unknown";

      const canDiff = item.before !== undefined || item.after !== undefined;
      const meta = item.hunks ? `${item.hunks} hunk(s)` : "";

      let detail = "";

      if (canDiff) {
        const beforeText =
          item.before === null || item.before === undefined
            ? "(does not exist)"
            : String(item.before);

        const afterText =
          item.after === null || item.after === undefined
            ? "(deleted / empty)"
            : String(item.after);

        detail = `
          <details>
            <summary>Plain preview</summary>
            <h4>Before</h4><pre>${escapeHtml(beforeText.slice(0, 20000))}</pre>
            <h4>After</h4><pre>${escapeHtml(afterText.slice(0, 20000))}</pre>
          </details>`;
      }

      return `
        <div class="op">
          <div class="row">
            <input type="checkbox" class="op-check" data-index="${item.index}" checked>
            <span class="step">${n + 1}</span>
            <span class="badge ${item.kind}">${item.kind.toUpperCase()}</span>
            <code>${escapeHtml(label)}</code>
            <span class="meta">${meta}</span>
            ${
              canDiff
                ? `<button class="diff-btn secondary" data-index="${item.index}">Open Diff</button>`
                : ""
            }
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

  .hint { opacity: .6; font-size: 12px; }

  .warn { padding: 10px 12px; border-left: 3px solid #dca342;
          background: var(--vscode-textBlockQuote-background); margin: 12px 0; }

  .errors { border-left: 3px solid #c33; background: var(--vscode-textBlockQuote-background);
            padding: 10px 12px; margin: 12px 0; }

  .errors ul { margin: 6px 0 0 18px; padding: 0; }

  .top-actions { display: flex; gap: 8px; margin: 12px 0; }

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

  .diff-btn { margin-left: auto; }

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

  button:disabled { opacity: .5; cursor: not-allowed; }
</style>
</head>
<body>
  <h1>Paste Ops — review before applying</h1>
  <div class="hint">
    ${logItems.length} valid operation(s). Unchecking an operation may break dependent later operations.
  </div>

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

  <div class="top-actions">
    <button id="select-all" class="secondary">Select all</button>
    <button id="select-none" class="secondary">Select none</button>
  </div>

  ${items}

  <div class="footer">
    <button id="apply">Apply selected operation(s)</button>
    <button id="cancel" class="secondary">Cancel</button>
    <span class="hint">Nothing has been written to disk yet.</span>
  </div>

<script nonce="${nonce}">
  const api = acquireVsCodeApi();

  const applyBtn = document.getElementById("apply");
  const cancelBtn = document.getElementById("cancel");
  const selectAll = document.getElementById("select-all");
  const selectNone = document.getElementById("select-none");

  function checks() {
    return Array.from(document.querySelectorAll(".op-check"));
  }

  function selectedIndexes() {
    return checks()
      .filter((c) => c.checked)
      .map((c) => Number(c.dataset.index));
  }

  function update() {
    const n = selectedIndexes().length;
    applyBtn.textContent = "Apply " + n + " selected operation(s)";
    applyBtn.disabled = n === 0;
  }

  checks().forEach((c) => c.addEventListener("change", update));

  selectAll.onclick = () => {
    checks().forEach((c) => (c.checked = true));
    update();
  };

  selectNone.onclick = () => {
    checks().forEach((c) => (c.checked = false));
    update();
  };

  applyBtn.onclick = () => {
    api.postMessage({ command: "apply", selected: selectedIndexes() });
  };

  cancelBtn.onclick = () => {
    api.postMessage({ command: "cancel" });
  };

  document.querySelectorAll(".diff-btn").forEach((btn) => {
    btn.onclick = () => {
      api.postMessage({ command: "diff", index: Number(btn.dataset.index) });
    };
  });

  update();
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

    const itemByIndex = new Map(logItems.map((item) => [item.index, item]));
    const nonce = crypto.randomBytes(16).toString("hex");

    panel.webview.html = previewHtml(logItems, errors, nonce);

    function finish(value) {
      if (settled) return;
      settled = true;
      resolve(value);
      panel.dispose();
    }

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "apply") {
        finish({
          selected: Array.isArray(msg.selected) ? msg.selected : [],
        });
      } else if (msg.command === "cancel") {
        finish(null);
      } else if (msg.command === "diff") {
        const item = itemByIndex.get(msg.index);
        if (item) openDiff(item);
      }
    });

    panel.onDidDispose(() => finish(null));
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
    vscode.workspace.registerTextDocumentContentProvider("pasteops-diff", {
      provideTextDocumentContent(uri) {
        return diffStore.get(uri.path) ?? "";
      },
    }),

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
          if (errors.length) {
            fail(`No valid operations. ${errors.length} block(s) skipped.`, errors);
          } else {
            vscode.window.showWarningMessage(
              "No file: / patch: / rename: / delete: / dir: blocks found."
            );
          }
          return;
        }

        const backend = memoryBackend(root);
        const plan = executeTolerant(parsed.ops, backend);

        errors.push(...plan.errors);

        if (!plan.validOps.length) {
          fail(`No valid operations. ${errors.length} block(s) skipped.`, errors);
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

        const choice = await showPreview(plan.log, errors);

        if (!choice) {
          vscode.window.showInformationMessage("Cancelled. Nothing was written.");
          return;
        }

        const selectedSet = new Set(choice.selected.map(Number));

        const selectedOps = plan.results
          .filter((r) => r.status === "ok" && selectedSet.has(r.index))
          .map((r) => r.op);

        if (!selectedOps.length) {
          vscode.window.showWarningMessage("No operations selected.");
          return;
        }

        const selectedBackend = memoryBackend(root);
        const selectedPlan = executeTolerant(selectedOps, selectedBackend);

        if (
          selectedPlan.errors.length ||
          selectedPlan.validOps.length !== selectedOps.length
        ) {
          fail(
            "Selected operations failed validation. Nothing was written.",
            selectedPlan.errors
          );
          return;
        }

        preflight(root, selectedBackend.snapshot);

        execute(selectedPlan.validOps, diskBackend(root));

        const unselected = plan.validOps.length - selectedOps.length;

        log(
          `Applied ${selectedPlan.validOps.length}, ` +
            `skipped ${errors.length} invalid, ` +
            `${unselected} unselected.`
        );

        vscode.window.showInformationMessage(
          `Paste Ops: applied ${selectedPlan.validOps.length}, ` +
            `skipped ${errors.length + unselected}.`
        );
      } catch (e) {
        fail(e.message);
      }
    })
  );
}

module.exports = { activate };