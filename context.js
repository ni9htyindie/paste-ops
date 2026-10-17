"use strict";

const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");
const child_process = require("child_process");

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

function parseGitignorePatterns(content, relativeDir) {
  const patterns = [];
  const lines = content.split(/\r?\n/);

  for (let line of lines) {
    line = line.replace(/\r$/, "").trimEnd();
    if (!line || line.startsWith("#")) continue;

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }

    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line) continue;
    line = line.replace(/\\(\s+)$/, "$1");

    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }

    const anchored = line.startsWith("/");
    if (anchored) {
      line = line.slice(1);
    }

    patterns.push({ pattern: line, negated, dirOnly, anchored, relativeDir });
  }

  return patterns;
}

function gitignorePatternToRegex(pattern, anchored, relativeDir) {
  let regexStr = "";

  if (relativeDir) {
    regexStr += relativeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/";
  }

  if (anchored || pattern.includes("/")) {
    regexStr = "^" + regexStr;
  } else {
    regexStr = "(^|.*/)" + regexStr;
  }

  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        regexStr += "[^/]*";
        i++;
      }
    } else if (pattern[i] === "?") {
      regexStr += "[^/]";
      i++;
    } else if (pattern[i] === "[") {
      let j = i + 1;
      let charClass = "[";
      if (j < pattern.length && (pattern[j] === "!" || pattern[j] === "^")) {
        charClass += "^";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        charClass += pattern[j].replace(/[\\]/g, "\\\\");
        j++;
      }
      if (j < pattern.length) {
        charClass += "]";
        regexStr += charClass;
        i = j + 1;
      } else {
        regexStr += "\\[";
        i++;
      }
    } else {
      regexStr += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }

  regexStr += "(?:/.*)?$";

  try {
    return new RegExp(regexStr);
  } catch {
    return null;
  }
}

function slashPath(p) {
  return String(p || "").replace(/\\/g, "/");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDotGitPath(rel) {
  return rel === ".git" || rel.split("/").includes(".git");
}

function execGit(args, cwd) {
  return new Promise((resolve) => {
    try {
      child_process.execFile(
        "git",
        args,
        { cwd, windowsHide: true },
        (error, stdout) => {
          if (error) resolve(null);
          else resolve(String(stdout || "").trim());
        }
      );
    } catch {
      resolve(null);
    }
  });
}

async function getGitRoot(cwd) {
  const top = await execGit(["rev-parse", "--show-toplevel"], cwd);

  if (!top) return null;

  try {
    return path.resolve(top);
  } catch {
    return null;
  }
}

function runGitCheckIgnoreChunk(gitRoot, relPaths) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let child;

    try {
      child = child_process.spawn(
        "git",
        ["-C", gitRoot, "check-ignore", "--stdin", "-z"],
        { windowsHide: true }
      );
    } catch {
      return finish(null);
    }

    const chunks = [];

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}

      finish(null);
    }, 20000);

    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });

    child.stdout.on("data", (d) => chunks.push(d));

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0 && code !== 1) {
        return finish(null);
      }

      const text = Buffer.concat(chunks).toString("utf8");
      const set = new Set();

      for (const p of text.split("\0")) {
        const clean = slashPath(p).replace(/^\.\//, "").trim();

        if (clean) {
          set.add(clean);
        }
      }

      finish(set);
    });

    try {
      child.stdin.write(relPaths.join("\0") + "\0");
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

async function gitCheckIgnore(gitRoot, relPaths) {
  const unique = Array.from(new Set(relPaths.filter(Boolean)));

  if (!unique.length) return new Set();

  const result = new Set();
  const CHUNK = 10000;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = await runGitCheckIgnoreChunk(
      gitRoot,
      unique.slice(i, i + CHUNK)
    );

    if (part === null) return null;

    for (const p of part) {
      result.add(p);
    }
  }

  return result;
}

function parseGitignoreRules(content, relativeDir) {
  const patterns = [];
  const lines = content.split(/\r?\n/);

  for (let line of lines) {
    line = line.trimEnd();

    if (!line || line.startsWith("#")) continue;

    let negated = false;

    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }

    line = line.replace(/\s+$/, "");

    if (!line) continue;

    let dirOnly = false;

    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }

    let anchored = false;

    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    }

    if (!line) continue;

    patterns.push({
      pattern: line,
      negated,
      dirOnly,
      anchored,
      relativeDir,
    });
  }

  return patterns;
}

function buildGitignoreRegex(pattern, anchored, relativeDir) {
  let regexStr = "^";

  if (relativeDir) {
    regexStr += escapeRegex(relativeDir) + "/";
  }

  if (!anchored && !pattern.includes("/")) {
    regexStr += "(?:.*/)?";
  }

  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        regexStr += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (ch === "[") {
      let j = i + 1;
      let cls = "[";

      if (j < pattern.length && (pattern[j] === "!" || pattern[j] === "^")) {
        cls += "^";
        j++;
      }

      while (j < pattern.length && pattern[j] !== "]") {
        cls += pattern[j];
        j++;
      }

      if (j < pattern.length) {
        cls += "]";
        regexStr += cls;
        i = j + 1;
      } else {
        regexStr += "\\[";
        i++;
      }
    } else {
      regexStr += escapeRegex(ch);
      i++;
    }
  }

  regexStr += "(?:/.*)?$";

  try {
    return new RegExp(regexStr);
  } catch {
    return null;
  }
}

function isIgnoredByRules(relativePath, rules) {
  if (!relativePath || relativePath === ".") return false;
  if (relativePath.endsWith(".gitignore")) return false;

  let ignored = false;

  for (const rule of rules) {
    if (rule.regex.test(relativePath)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

async function readGitignoreRulesForFolder(folderUri, uris) {
  const rootFs = folderUri.fsPath;
  const dirs = new Set([rootFs]);

  for (const uri of uris) {
    let dir = path.dirname(uri.fsPath);
    let guard = 0;

    while (dir && guard < 100) {
      dirs.add(dir);

      if (dir === rootFs) break;

      const parent = path.dirname(dir);

      if (!parent || parent === dir) break;

      dir = parent;
      guard++;
    }
  }

  const sorted = Array.from(dirs).sort(
    (a, b) => a.length - b.length || a.localeCompare(b)
  );

  const rules = [];
  let readCount = 0;

  for (const dir of sorted) {
    if (readCount >= 200) break;

    const relDirRaw = slashPath(path.relative(rootFs, dir));
    const relDir = relDirRaw === "." ? "" : relDirRaw;

    if (relDir && isIgnoredByRules(relDir, rules)) {
      continue;
    }

    try {
      const giUri = vscode.Uri.joinPath(vscode.Uri.file(dir), ".gitignore");
      const content = await vscode.workspace.fs.readFile(giUri);
      const text = Buffer.from(content).toString("utf8");

      const patterns = parseGitignoreRules(text, relDir);

      for (const p of patterns) {
        const regex = buildGitignoreRegex(p.pattern, p.anchored, p.relativeDir);

        if (regex) {
          rules.push({ ...p, regex });
        }
      }

      readCount++;
    } catch {}
  }

  return rules;
}

async function filterByGitignore(uris) {
  if (!uris.length) return { kept: uris, removed: 0 };

  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    return { kept: uris, removed: 0 };
  }

  const kept = [];
  let removed = 0;

  const byFolder = new Map();
  const outside = [];

  for (const uri of uris) {
    const wf = vscode.workspace.getWorkspaceFolder(uri);

    if (!wf) {
      outside.push(uri);
      continue;
    }

    const key = wf.uri.toString();

    if (!byFolder.has(key)) {
      byFolder.set(key, { folder: wf, uris: [] });
    }

    byFolder.get(key).uris.push(uri);
  }

  kept.push(...outside);

  for (const group of byFolder.values()) {
    const folder = group.folder;
    const folderUris = group.uris;

    const gitRoot = await getGitRoot(folder.uri.fsPath);
    let ignoredSet = null;

    if (gitRoot) {
      const rels = [];
      const relMap = new Map();

      for (const uri of folderUris) {
        const raw = path.relative(gitRoot, uri.fsPath);

        if (!raw || raw.startsWith("..") || path.isAbsolute(raw)) {
          continue;
        }

        const rel = slashPath(raw);

        rels.push(rel);
        relMap.set(uri.toString(), rel);
      }

      ignoredSet = await gitCheckIgnore(gitRoot, rels);

      if (ignoredSet) {
        for (const uri of folderUris) {
          const rel = relMap.get(uri.toString());

          if (!rel) {
            kept.push(uri);
            continue;
          }

          if (isDotGitPath(rel)) {
            removed++;
            continue;
          }

          if (rel === ".gitignore" || rel.endsWith("/.gitignore")) {
            kept.push(uri);
            continue;
          }

          if (ignoredSet.has(rel)) {
            removed++;
          } else {
            kept.push(uri);
          }
        }

        continue;
      }
    }

    const rules = await readGitignoreRulesForFolder(folder.uri, folderUris);

    for (const uri of folderUris) {
      const raw = path.relative(folder.uri.fsPath, uri.fsPath);

      if (!raw || raw.startsWith("..") || path.isAbsolute(raw)) {
        kept.push(uri);
        continue;
      }

      const rel = slashPath(raw);

      if (isDotGitPath(rel)) {
        removed++;
        continue;
      }

      if (rel === ".gitignore" || rel.endsWith("/.gitignore")) {
        kept.push(uri);
        continue;
      }

      if (isIgnoredByRules(rel, rules)) {
        removed++;
      } else {
        kept.push(uri);
      }
    }
  }

  return { kept, removed };
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

  .overview-totals { border-left: 3px solid var(--vscode-textLink-foreground, #3794ff); }
</style>
</head>
<body>
  <h1>Paste Ops — Copy Files as Context</h1>
  <div class="hint">
    Uncheck files you do not want. Token counts are estimates.
    Full copy includes file contents. Overview copies only the folder/file tree.
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

  <div class="totals overview-totals">
    <div id="overview-files">Overview files: 0</div>
    <div id="overview-folders">Folders: 0</div>
    <div id="overview-chars">Overview characters: 0</div>
    <div id="overview-tokens">Estimated overview tokens: ~0</div>
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
    <button id="copy-overview" class="secondary">Copy selected overview</button>
    <button id="cancel" class="secondary">Cancel</button>
    <span class="hint">Full copy includes contents. Overview copies only the file tree.</span>
  </div>

<script nonce="${nonce}">
  const api = acquireVsCodeApi();

  const copyBtn = document.getElementById("copy");
  const copyOverviewBtn = document.getElementById("copy-overview");
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
    copyOverviewBtn.disabled = files === 0;

    requestOverviewMetrics();
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

  function selectedIndexes() {
    return Array.from(document.querySelectorAll(".file-check:checked"))
      .map((check) => Number(check.dataset.index));
  }

  let metricsSeq = 0;

  function requestOverviewMetrics() {
    metricsSeq++;

    api.postMessage({
      command: "overview-metrics",
      selected: selectedIndexes(),
      seq: metricsSeq,
    });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;

    if (!msg || msg.command !== "overview-metrics") return;
    if (msg.seq !== metricsSeq) return;

    document.getElementById("overview-files").textContent =
      "Overview files: " + (msg.files || 0);

    document.getElementById("overview-folders").textContent =
      "Folders: " + (msg.folders || 0);

    document.getElementById("overview-chars").textContent =
      "Overview characters: " + (msg.chars || 0).toLocaleString();

    document.getElementById("overview-tokens").textContent =
      "Estimated overview tokens: ~" + (msg.tokens || 0).toLocaleString();
  });

  copyBtn.onclick = () => {
    api.postMessage({ command: "copy", selected: selectedIndexes() });
  };

  copyOverviewBtn.onclick = () => {
    api.postMessage({
      command: "copy-overview",
      selected: selectedIndexes(),
    });
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
        finish({
          mode: "full",
          selected: Array.isArray(msg.selected) ? msg.selected : [],
        });
      } else if (msg.command === "copy-overview") {
        finish({
          mode: "overview",
          selected: Array.isArray(msg.selected) ? msg.selected : [],
        });
      } else if (msg.command === "cancel") {
        finish(null);
      } else if (msg.command === "overview-metrics") {
        const overview = buildOverview(entries, msg.selected || []);
        const chars = overview.text.length;

        panel.webview.postMessage({
          command: "overview-metrics",
          seq: msg.seq,
          files: overview.files,
          folders: overview.folders,
          chars,
          tokens: Math.ceil(chars / 4),
          bytes: Buffer.byteLength(overview.text, "utf8"),
        });
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

function buildOverviewTree(rels) {
  const root = { dirs: new Map(), files: new Set() };

  for (const rel of rels) {
    const parts = rel.split("/").filter(Boolean);
    if (!parts.length) continue;

    let node = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];

      if (!node.dirs.has(name)) {
        node.dirs.set(name, { dirs: new Map(), files: new Set() });
      }

      node = node.dirs.get(name);
    }

    node.files.add(parts[parts.length - 1]);
  }

  const lines = [];
  let folderCount = 0;

  function walk(node, prefix) {
    const children = [];

    for (const name of node.dirs.keys()) {
      children.push({ name, isDir: true });
    }

    for (const name of node.files) {
      children.push({ name, isDir: false });
    }

    children.sort((a, b) => a.name.localeCompare(b.name));

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const last = i === children.length - 1;

      lines.push(
        prefix +
          (last ? "└── " : "├── ") +
          child.name +
          (child.isDir ? "/" : "")
      );

      if (child.isDir) {
        folderCount++;
        walk(node.dirs.get(child.name), prefix + (last ? "    " : "│   "));
      }
    }
  }

  walk(root, "");

  return { text: lines.join("\n"), folders: folderCount };
}

function buildOverview(entries, selectedIndexes) {
  const rels = Array.from(
    new Set(
      selectedIndexes
        .map((i) => entries[i])
        .filter((e) => e && !e.error && e.rel)
        .map((e) => e.rel)
    )
  ).sort();

  if (!rels.length) {
    return { text: "", files: 0, folders: 0 };
  }

  const tree = buildOverviewTree(rels);
  const text = "```text:project-overview\n" + tree.text + "\n```\n";

  return { text, files: rels.length, folders: tree.folders };
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

    const { kept, removed } = await filterByGitignore(expanded);

    if (!kept.length) {
      vscode.window.showWarningMessage(
        `All ${expanded.length} selected file(s) are excluded by .gitignore.`
      );
      return;
    }

    if (removed > 0) {
      vscode.window.setStatusBarMessage(
        `Paste Ops: ${removed} file(s) excluded by .gitignore`,
        5000
      );
    }

    const entries = await loadEntries(kept);

    if (!entries.length) {
      vscode.window.showWarningMessage("No readable files found.");
      return;
    }

    const choice = await showContextPreview(entries);

    if (!choice || !choice.selected || choice.selected.length === 0) return;

    const isOverview = choice.mode === "overview";

    const overview = isOverview
      ? buildOverview(entries, choice.selected)
      : null;

    const text = isOverview
      ? overview.text
      : buildContextText(entries, choice.selected);

    if (!text.trim()) {
      vscode.window.showWarningMessage("Nothing selected to copy.");
      return;
    }

    await vscode.env.clipboard.writeText(text);

    if (isOverview) {
      const chars = text.length;
      const tokens = Math.ceil(chars / 4);

      vscode.window.showInformationMessage(
        `Paste Ops: copied overview — ${overview.files} file(s), ` +
          `${overview.folders} folder(s), ` +
          `${chars.toLocaleString()} chars, ` +
          `~${tokens.toLocaleString()} tokens. No file contents included.`
      );

      return;
    }

    const selectedEntries = choice.selected
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