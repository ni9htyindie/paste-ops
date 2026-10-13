"use strict";

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  parseClipboard,
  execute,
  executeTolerant,
  memoryBackend,
  diskBackend,
  preflight,
} = require("./core");
const { activate: activateContext } = require("./context");

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

/* ---------------- dependencies ---------------- */

function diskExists(root, rel) {
  try {
    return fs.existsSync(path.resolve(root, ...rel.split("/")));
  } catch {
    return false;
  }
}

function annotateDependencies(items, root) {
  const annotations = items.map((item) => ({
    ...item,
    deps: [],
    depNotes: [],
  }));

  const state = new Map();
  const dirRenames = [];
  const existsCache = new Map();

  function exists(rel) {
    if (!existsCache.has(rel)) {
      existsCache.set(rel, diskExists(root, rel));
    }
    return existsCache.get(rel);
  }

  function addDep(item, producer, note) {
    if (producer >= 0 && !item.deps.includes(producer)) {
      item.deps.push(producer);
      item.depNotes.push(note);
    }
  }

  for (const item of annotations) {
    const requires = [];

    if (item.kind === "patch" || item.kind === "delete") {
      requires.push(item.path);
    }

    if (item.kind === "rename") {
      requires.push(item.from);
    }

    for (const req of requires) {
      if (!req) continue;

      if (state.has(req)) {
        const producer = state.get(req);
        addDep(item, producer, `depends on #${producer + 1} for ${req}`);
      } else if (!exists(req)) {
        for (const r of dirRenames) {
          if (req.startsWith(r.to + "/")) {
            addDep(
              item,
              r.index,
              `depends on rename #${r.index + 1} for folder ${r.to}`
            );
            break;
          }
        }
      }
    }

    if (item.kind === "file" || item.kind === "patch") {
      state.set(item.path, item.index);
    } else if (item.kind === "delete") {
      state.delete(item.path);
    } else if (item.kind === "rename") {
      state.delete(item.from);
      state.set(item.to, item.index);
      dirRenames.push({
        from: item.from,
        to: item.to,
        index: item.index,
      });
    } else if (item.kind === "mkdir") {
      state.set(item.path, item.index);
    }
  }

  return annotations;
}

/* ---------------- inline diff ---------------- */

function diffLineHtml(kind, text) {
  const escaped = escapeHtml(text) || "&nbsp;";
  const prefix = kind === "add" ? "+ " : kind === "del" ? "- " : "  ";
  return `<div class="diff-line ${kind}">${prefix}${escaped}</div>`;
}

function inlineDiffHtml(before, after) {
  const oldText =
    before === null || before === undefined ? "" : String(before);

  const newText =
    after === null || after === undefined ? "" : String(after);

  if (oldText === newText) {
    return '<div class="hint">No content change.</div>';
  }

  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");

  const MAX_LINES = 500;
  const MAX_CHARS = 120000;

  if (
    a.length > MAX_LINES ||
    b.length > MAX_LINES ||
    oldText.length > MAX_CHARS ||
    newText.length > MAX_CHARS
  ) {
    return '<div class="hint">Inline diff is too large. Use Open Diff.</div>';
  }

  const n = a.length;
  const m = b.length;

  const dp = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Uint16Array(m + 1));
  }

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  let i = 0;
  let j = 0;
  const out = [];

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(diffLineHtml("same", a[i]));
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(diffLineHtml("del", a[i]));
      i++;
    } else {
      out.push(diffLineHtml("add", b[j]));
      j++;
    }
  }

  while (i < n) {
    out.push(diffLineHtml("del", a[i]));
    i++;
  }

  while (j < m) {
    out.push(diffLineHtml("add", b[j]));
    j++;
  }

  return `<div class="inline-diff">${out.join("")}</div>`;
}

/* ---------------- inline diff engine ---------------- */

function renderDiffStatesCollapsed(states) {
  const out = [];
  const COLLAPSE_LIMIT = 200;
  const KEEP = 20;

  let i = 0;

  while (i < states.length) {
    if (states[i].type === "same") {
      out.push(
        diffLineHtml("same", states[i].oldLine ?? states[i].newLine ?? "")
      );
      i++;
      continue;
    }

    const start = i;

    while (i < states.length && states[i].type !== "same") {
      i++;
    }

    const run = states.slice(start, i);

    if (run.length <= COLLAPSE_LIMIT) {
      for (const s of run) {
        if (s.type === "add") {
          out.push(diffLineHtml("add", s.newLine ?? ""));
        } else {
          out.push(diffLineHtml("del", s.oldLine ?? ""));
        }
      }
    } else {
      for (let x = 0; x < KEEP; x++) {
        const s = run[x];

        if (s.type === "add") {
          out.push(diffLineHtml("add", s.newLine ?? ""));
        } else {
          out.push(diffLineHtml("del", s.oldLine ?? ""));
        }
      }

      out.push(
        `<div class="diff-gap">${run.length - KEEP * 2} changed line(s) collapsed. Use Open Diff for full detail.</div>`
      );

      for (let x = run.length - KEEP; x < run.length; x++) {
        const s = run[x];

        if (s.type === "add") {
          out.push(diffLineHtml("add", s.newLine ?? ""));
        } else {
          out.push(diffLineHtml("del", s.oldLine ?? ""));
        }
      }
    }
  }

  return out.join("");
}

function statesToHunks(states, context = 2) {
  const changeIndexes = [];

  for (let i = 0; i < states.length; i++) {
    if (states[i].type !== "same") {
      changeIndexes.push(i);
    }
  }

  if (!changeIndexes.length) return [];

  const ranges = [];

  let start = Math.max(0, changeIndexes[0] - context);
  let end = Math.min(states.length - 1, changeIndexes[0] + context);

  for (let n = 1; n < changeIndexes.length; n++) {
    const idx = changeIndexes[n];

    const s = Math.max(0, idx - context);
    const e = Math.min(states.length - 1, idx + context);

    if (s <= end + 1) {
      end = Math.max(end, e);
    } else {
      ranges.push([start, end]);
      start = s;
      end = e;
    }
  }

  ranges.push([start, end]);

  return ranges.map(([s, e]) => states.slice(s, e + 1));
}

function renderStatesHunks(states) {
  const hunks = statesToHunks(states, 2);

  if (!hunks.length) {
    return '<div class="hint">No content change.</div>';
  }

  return `<div class="inline-diff">${hunks
    .map((h) => `<div class="diff-hunk">${renderDiffStatesCollapsed(h)}</div>`)
    .join('<div class="diff-gap">⋯</div>')}</div>`;
}

function backtrackMyers(trace, D, a, b) {
  if (D === 0) {
    return a.map((line) => ({
      type: "same",
      oldLine: line,
      newLine: line,
    }));
  }

  let x = a.length;
  let y = b.length;

  const edits = [];

  for (let d = D; d > 0; d--) {
    const v = trace[d];
    const k = x - y;

    let prevK;

    if (k === -d) {
      prevK = k + 1;
    } else if (k === d) {
      prevK = k - 1;
    } else {
      const down = v.get(k + 1) ?? -1;
      const right = v.get(k - 1) ?? -1;
      prevK = right < down ? k + 1 : k - 1;
    }

    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      edits.push({
        type: "same",
        oldLine: a[x - 1],
        newLine: b[y - 1],
      });
      x--;
      y--;
    }

    if (x === prevX) {
      edits.push({ type: "add", newLine: b[y - 1] });
      y--;
    } else {
      edits.push({ type: "del", oldLine: a[x - 1] });
      x--;
    }

    x = prevX;
    y = prevY;
  }

  while (x > 0 && y > 0) {
    edits.push({
      type: "same",
      oldLine: a[x - 1],
      newLine: b[y - 1],
    });
    x--;
    y--;
  }

  return edits.reverse();
}

function myersStates(a, b, maxD = 2000) {
  const N = a.length;
  const M = b.length;

  if (N === 0 && M === 0) return [];

  if (N === 0) {
    return b.map((line) => ({ type: "add", newLine: line }));
  }

  if (M === 0) {
    return a.map((line) => ({ type: "del", oldLine: line }));
  }

  const trace = [];
  const v = new Map([[0, 0]]);

  for (let d = 0; d <= maxD; d++) {
    trace.push(new Map(v));

    for (let k = -d; k <= d; k += 2) {
      let x;

      if (
        k === -d ||
        (k !== d && (v.get(k + 1) ?? -1) > (v.get(k - 1) ?? -1))
      ) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }

      let y = x - k;

      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }

      v.set(k, x);

      if (x >= N && y >= M) {
        return backtrackMyers(trace, d, a, b);
      }
    }
  }

  return null;
}

function prefixSuffixHunkStates(a, b, context = 2) {
  let start = 0;
  const minLen = Math.min(a.length, b.length);

  while (start < minLen && a[start] === b[start]) {
    start++;
  }

  let endA = a.length;
  let endB = b.length;

  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  if (start === endA && start === endB) return [];

  const states = [];

  const preStart = Math.max(0, start - context);

  for (let i = preStart; i < start; i++) {
    states.push({ type: "same", oldLine: a[i], newLine: b[i] });
  }

  for (let i = start; i < endA; i++) {
    states.push({ type: "del", oldLine: a[i] });
  }

  for (let i = start; i < endB; i++) {
    states.push({ type: "add", newLine: b[i] });
  }

  const postCount = Math.min(context, a.length - endA, b.length - endB);

  for (let i = 0; i < postCount; i++) {
    states.push({
      type: "same",
      oldLine: a[endA + i],
      newLine: b[endB + i],
    });
  }

  return states;
}

function renderPatchHunks(before, hunks) {
  let working = String(before ?? "").replace(/\r\n/g, "\n");

  const renderedHunks = [];

  for (const hunk of hunks) {
    const search = String(hunk.search ?? "").replace(/\r\n/g, "\n");
    const replace = String(hunk.replace ?? "").replace(/\r\n/g, "\n");

    const states = [];
    const idx = working.indexOf(search);

    if (idx >= 0) {
      const lineStart = working.lastIndexOf("\n", idx - 1) + 1;

      const beforeText = working.slice(0, lineStart);
      const preLines = beforeText === "" ? [] : beforeText.split("\n");
      const preContext = preLines.slice(-2);

      const searchEnd = idx + search.length;
      const nextLineStart = working.indexOf("\n", searchEnd);
      const postText =
        nextLineStart === -1 ? "" : working.slice(nextLineStart + 1);
      const postLines = postText === "" ? [] : postText.split("\n");
      const postContext = postLines.slice(0, 2);

      for (const line of preContext) {
        states.push({ type: "same", oldLine: line, newLine: line });
      }

      for (const line of search.split("\n")) {
        states.push({ type: "del", oldLine: line });
      }

      for (const line of replace.split("\n")) {
        states.push({ type: "add", newLine: line });
      }

      for (const line of postContext) {
        states.push({ type: "same", oldLine: line, newLine: line });
      }

      working = working.replace(search, () => replace);
    } else {
      for (const line of search.split("\n")) {
        states.push({ type: "del", oldLine: line });
      }

      for (const line of replace.split("\n")) {
        states.push({ type: "add", newLine: line });
      }
    }

    renderedHunks.push(
      `<div class="diff-hunk">${renderDiffStatesCollapsed(states)}</div>`
    );
  }

  return `<div class="inline-diff">${renderedHunks.join(
    '<div class="diff-gap">⋯</div>'
  )}</div>`;
}

function inlineDiffHtmlForItem(item) {
  const before =
    item.before === null || item.before === undefined
      ? ""
      : String(item.before);

  const after =
    item.after === null || item.after === undefined
      ? ""
      : String(item.after);

  if (before === after) {
    return '<div class="hint">No content change.</div>';
  }

  if (
    item.kind === "patch" &&
    Array.isArray(item.patchHunks) &&
    item.patchHunks.length
  ) {
    return renderPatchHunks(before, item.patchHunks);
  }

  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");

  const MAX_MYERS_LINES = 20000;

  if (a.length <= MAX_MYERS_LINES && b.length <= MAX_MYERS_LINES) {
    const states = myersStates(a, b, 2000);

    if (states) {
      return renderStatesHunks(states);
    }
  }

  const fallback = prefixSuffixHunkStates(a, b, 2);

  if (!fallback.length) {
    return '<div class="hint">No content change.</div>';
  }

  return `<div class="inline-diff"><div class="diff-hunk">${renderDiffStatesCollapsed(
    fallback
  )}</div></div>`;
}

/* ---------------- native diff ---------------- */

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

  vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${label} — Paste Ops`
  );
}

/* ---------------- preview ---------------- */

function previewHtml(logItems, errors, nonce) {
  const destructive = logItems.some((x) =>
    ["delete", "rmdir", "write"].includes(x.kind)
  );

  function renderItem(item) {
    const label =
      item.kind === "rename"
        ? `${item.from} → ${item.to}`
        : item.path || "unknown";

    const canDiff = item.before !== undefined || item.after !== undefined;

    const meta = item.hunks ? `${item.hunks} hunk(s)` : "";

    const diffButton = canDiff
      ? `<button class="diff-btn secondary" data-index="${item.index}">Open Diff</button>`
      : "";

    const deps = item.deps || [];

    const depNote = deps.length
      ? `<div class="dep-note">Depends on ${deps
          .map((d) => `#${d + 1}`)
          .join(", ")}</div>`
      : "";

    const inlineDiff = canDiff
      ? `<div class="diff-box">${inlineDiffHtmlForItem(item)}</div>`
      : "";

    return `
      <div class="op" data-index="${item.index}" data-deps="${deps.join(",")}">
        <div class="row">
          <input type="checkbox" class="op-check" data-index="${item.index}" checked>
          <span class="step">#${item.index + 1}</span>
          <span class="badge ${item.kind}">${item.kind.toUpperCase()}</span>
          <code>${escapeHtml(label)}</code>
          <span class="meta">${meta}</span>
          ${diffButton}
        </div>

        ${depNote}
        <div class="dep-warning-note hidden"></div>

        ${inlineDiff}
      </div>`;
  }

  const groups = new Map();

  for (const item of logItems) {
    const key =
      item.kind === "rename" ? item.to : item.path || "other";

    if (!groups.has(key)) {
      groups.set(key, { key, items: [] });
    }

    groups.get(key).items.push(item);
  }

  const groupsHtml = Array.from(groups.values())
    .map((group) => {
      const inner = group.items.map(renderItem).join("");

      return `
        <div class="group">
          <div class="group-title">
            <code>${escapeHtml(group.key)}</code>
            <span class="meta">${group.items.length} operation(s)</span>
          </div>
          ${inner}
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

  .hidden { display: none; }

  .warn { padding: 10px 12px; border-left: 3px solid #dca342;
          background: var(--vscode-textBlockQuote-background); margin: 12px 0; }

  .errors { border-left: 3px solid #c33; background: var(--vscode-textBlockQuote-background);
            padding: 10px 12px; margin: 12px 0; }

  .errors ul { margin: 6px 0 0 18px; padding: 0; }

  .top-actions { display: flex; gap: 8px; margin: 12px 0; }

  .group { border: 1px solid var(--vscode-widget-border, #444);
           border-radius: 8px; margin: 14px 0; padding: 10px; }

  .group-title { font-weight: 600; margin-bottom: 8px;
                 display: flex; align-items: center; gap: 8px; }

  .op { border: 1px solid var(--vscode-widget-border, #333);
        border-left: 3px solid transparent;
        border-radius: 6px; margin: 10px 0; padding: 10px 12px; }

  .op.dep-warning { border-left: 3px solid #dca342;
                    background: rgba(220, 163, 66, 0.08); }

  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

  .step { opacity: .5; font-size: 12px; }

  .badge { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 4px;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  .badge.delete, .badge.rmdir { background: #a33; color: #fff; }
  .badge.rename { background: #369; color: #fff; }

  code { font-family: var(--vscode-editor-font-family); }

  .meta { opacity: .6; font-size: 12px; }

  .diff-btn { margin-left: auto; }

  .dep-note { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }

  .dep-warning-note { font-size: 11px; color: #dca342; margin-top: 4px; }

  details { margin-top: 8px; }

  summary { cursor: pointer; opacity: .8; font-size: 12px; }

  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px;
        background: var(--vscode-textBlockQuote-background); padding: 10px;
        border-radius: 4px; max-height: 320px; overflow: auto; }

  h4 { margin: 12px 0 4px; font-size: 12px; opacity: .7; }

  .diff-box { margin-top: 10px; }

  .inline-diff { border-radius: 4px; overflow: auto; max-height: 280px;
                 padding: 6px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.08)); }

  .diff-line { font-family: var(--vscode-editor-font-family);
               font-size: 12px; white-space: pre; }

  .diff-line.add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(65, 160, 65, 0.18)); }
  .diff-line.del { background: var(--vscode-diffEditor-removedTextBackground, rgba(220, 70, 70, 0.18)); }
  .diff-line.same { opacity: .75; }

  .diff-hunk { margin-bottom: 6px; }

  .diff-gap { opacity: .55; text-align: center; font-size: 11px; margin: 4px 0; }

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

  ${groupsHtml}

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

  function updateDeps() {
    document.querySelectorAll(".op").forEach((op) => {
      const deps = (op.dataset.deps || "")
        .split(",")
        .filter(Boolean)
        .map(Number);

      const missing = deps.filter((d) => {
        const box = document.querySelector(
          '.op-check[data-index="' + d + '"]'
        );
        return !box || !box.checked;
      });

      op.classList.toggle("dep-warning", missing.length > 0);

      const note = op.querySelector(".dep-warning-note");

      if (note) {
        if (missing.length) {
          note.textContent =
            "Warning: dependency " +
            missing.map((m) => "#" + (m + 1)).join(", ") +
            " is unchecked.";
          note.classList.remove("hidden");
        } else {
          note.textContent = "";
          note.classList.add("hidden");
        }
      }
    });
  }

  function update() {
    const n = selectedIndexes().length;
    applyBtn.textContent = "Apply " + n + " selected operation(s)";
    applyBtn.disabled = n === 0;
    updateDeps();
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

function opLabel(op) {
  if (!op) return "unknown";

  if (op.kind === "rename") {
    return `rename ${op.from} -> ${op.to}`;
  }

  return `${op.kind} ${op.path || "unknown"}`;
}

function buildOpsReport({ state, root, plan, selectedSet, errors }) {
  const workspaceName = path.basename(root || "unknown");

  const selected = [];
  const unselected = [];

  for (const r of plan.results) {
    if (r.status !== "ok") continue;

    const line = `#${r.index + 1} ${opLabel(r.op)}`;

    if (selectedSet.has(r.index)) {
      selected.push(line);
    } else {
      unselected.push(line);
    }
  }

  const invalid = errors.length ? errors.map((e) => String(e)) : [];

  return [
    "```paste-ops-report",
    `state: ${state}`,
    `workspace: ${workspaceName}`,
    "",
    "selected:",
    selected.length ? selected.map((x) => `- ${x}`).join("\n") : "- none",
    "",
    "unselected:",
    unselected.length ? unselected.map((x) => `- ${x}`).join("\n") : "- none",
    "",
    "skipped-invalid:",
    invalid.length ? invalid.map((x) => `- ${x}`).join("\n") : "- none",
    "```",
    "",
  ].join("\n");
}

function activate(context) {
  activateContext(context);

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

        const annotated = annotateDependencies(plan.log, root);
        const choice = await showPreview(annotated, errors);

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

        const preApplyReport = buildOpsReport({
          state: "user-choice-before-apply",
          root,
          plan,
          selectedSet,
          errors,
        });

        await vscode.env.clipboard.writeText(preApplyReport);

        vscode.window.setStatusBarMessage(
          "Paste Ops: choice copied to clipboard",
          4000
        );

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

        const appliedReport = buildOpsReport({
          state: "applied",
          root,
          plan,
          selectedSet,
          errors,
        });

        await vscode.env.clipboard.writeText(appliedReport);

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