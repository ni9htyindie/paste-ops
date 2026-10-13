"use strict";

const fs = require("fs");
const path = require("path");

/* ---------------- paths ---------------- */

function cleanPath(raw) {
  let p = String(raw)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\\/g, "/");

  if (/^[a-z]:/i.test(p) || p.startsWith("/") || p.includes("\0")) return null;

  p = p.replace(/^(?:\.\/)+/, "");
  const parts = p.split("/");
  if (parts.some((x) => x === "..")) return null;

  const norm = parts.filter((x) => x && x !== ".").join("/");
  if (!norm || /[<>:"|?*]/.test(norm)) return null;
  if (norm.split("/").some((x) => x === ".git")) return null;
  return norm;
}

function absPath(root, rel) {
  const p = path.resolve(root, ...rel.split("/"));
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error("Path escapes workspace: " + rel);
  }
  return p;
}

function diskFile(root, rel) {
  try {
    const p = absPath(root, rel);
    if (!fs.statSync(p).isFile()) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function rejectSymlinks(root, rel) {
  let cur = root;
  for (const part of rel.split("/")) {
    cur = path.join(cur, part);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        throw new Error("Refusing symlink path: " + rel);
      }
    } catch (e) {
      if (String(e.message).startsWith("Refusing symlink")) throw e;
    }
  }
}

/* ---------------- line endings ---------------- */

const lf = (s) => s.replace(/\r\n/g, "\n");

function withEol(text, reference) {
  const t = lf(text);
  return reference && /\r\n/.test(reference) ? t.replace(/\n/g, "\r\n") : t;
}

/* ---------------- clipboard parser ---------------- */

const OP_RE = /^(file|patch|rename|delete|dir)\s*:\s*(.+)$/i;

function dedent(lines, n) {
  if (!n) return lines;
  return lines.map((line) => {
    let used = 0;
    let i = 0;
    while (i < line.length && used < n) {
      if (line[i] === "\t") used += 4;
      else if (line[i] === " ") used += 1;
      else break;
      i++;
    }
    return line.slice(i);
  });
}

function parseClipboard(text) {
  const lines = lf(text).split("\n");
  const ops = [];
  const parseErrors = [];
  let ignored = 0;
  let i = 0;

  while (i < lines.length) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*([^\n]*)$/);
    if (!open) {
      i++;
      continue;
    }

    const marker = open[2];
    const info = open[3].trim();
    const indent = open[1].replace(/\t/g, "    ").length;
    const lineNo = i + 1;

    let j = i + 1;
    const body = [];
    let closed = false;

    while (j < lines.length) {
      const close = lines[j].match(/^(\s*)(`{3,}|~{3,})\s*$/);
      if (close && close[2][0] === marker[0] && close[2].length >= marker.length) {
        closed = true;
        break;
      }
      body.push(lines[j]);
      j++;
    }

    const op = info.match(OP_RE);

    if (op) {
      if (!closed) {
        parseErrors.push(
          `Line ${lineNo}: unclosed ${op[1]} block. Skipping the rest of the clipboard.`
        );
        break;
      }

      try {
        const kind = op[1].toLowerCase();
        const arg = op[2].trim();
        const content = dedent(body, indent);

        if (kind === "rename") {
          const parts = arg.split(/\s*(?:->|→|=>)\s*/);
          if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
            throw new Error("Bad rename. Use: rename:old/path -> new/path");
          }

          const from = cleanPath(parts[0]);
          const to = cleanPath(parts[1]);

          if (!from || !to) {
            throw new Error(`Unsafe rename path: ${arg}`);
          }

          ops.push({ kind, from, to, line: lineNo });
        } else {
          const p = cleanPath(arg);

          if (!p) {
            throw new Error(`Unsafe path: ${arg}`);
          }

          ops.push({ kind, path: p, body: content, line: lineNo });
        }
      } catch (e) {
        parseErrors.push(`Line ${lineNo}: ${e.message}`);
      }
    } else if (info) {
      ignored++;
    }

    i = closed ? j + 1 : j;
  }

  return { ops, ignored, parseErrors };
}

/* ---------------- patch parser ---------------- */

function parseHunks(body) {
  const hunks = [];
  let i = 0;

  while (i < body.length) {
    if (!/^<{5,}\s*SEARCH\s*$/.test(body[i])) {
      i++;
      continue;
    }

    const start = i + 1;
    let sep = -1;
    let end = -1;

    for (let k = start; k < body.length; k++) {
      if (/^={5,}\s*$/.test(body[k])) {
        sep = k;
        break;
      }
    }
    if (sep === -1) throw new Error("SEARCH block has no '=======' separator.");

    for (let k = sep + 1; k < body.length; k++) {
      if (/^>{5,}\s*REPLACE\s*$/.test(body[k])) {
        end = k;
        break;
      }
    }
    if (end === -1) throw new Error("SEARCH block has no '>>>>>>> REPLACE' terminator.");

    const search = body.slice(start, sep).join("\n");
    const replace = body.slice(sep + 1, end).join("\n");

    if (!search.length) throw new Error("Empty SEARCH block. Use ```file: to create a file.");

    hunks.push({ search, replace });
    i = end + 1;
  }

  if (!hunks.length) {
    throw new Error(
      "No SEARCH/REPLACE hunks found. Expected:\n<<<<<<< SEARCH\n...\n=======\n...\n>>>>>>> REPLACE"
    );
  }

  return hunks;
}

function countOccur(haystack, needle) {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

function applyHunk(content, hunk) {
  const text = lf(content);
  let needle = hunk.search;
  let replacement = hunk.replace;
  let count = countOccur(text, needle);

  if (count === 0 && !needle.endsWith("\n")) {
    const withNewline = needle + "\n";
    const c = countOccur(text, withNewline);
    if (c > 0) {
      needle = withNewline;
      replacement = replacement.length ? replacement + "\n" : "";
      count = c;
    }
  }

  if (count === 0) {
    throw new Error(
      "SEARCH not found verbatim. Copy the exact current lines with surrounding context, " +
      "or use ```file: to rewrite the whole file."
    );
  }

  if (count > 1) {
    throw new Error(
      `SEARCH matches ${count} places. Add more surrounding context to make it unique.`
    );
  }

  return text.replace(needle, () => replacement);
}

/* ---------------- in-memory backend (dry run) ---------------- */

function memoryBackend(root) {
  const files = new Map();
  const dirs = new Set();
  const deadFiles = new Set();
  const deadDirs = new Set();
  const snapshot = new Map();

  const isDead = (rel) =>
    deadFiles.has(rel) ||
    Array.from(deadDirs).some((d) => rel === d || rel.startsWith(d + "/"));

  function snap(rel) {
    if (!snapshot.has(rel)) snapshot.set(rel, diskFile(root, rel));
  }

  function read(rel) {
    if (files.has(rel)) return files.get(rel);
    if (isDead(rel)) throw new Error("Path was deleted earlier in this response: " + rel);
    snap(rel);
    const content = snapshot.get(rel);
    if (content === null) {
      throw new Error("File does not exist: " + rel + ". Use ```file: to create it.");
    }
    files.set(rel, content);
    return content;
  }

  function readIfExists(rel) {
    if (files.has(rel)) return files.get(rel);
    if (isDead(rel)) return null;
    snap(rel);
    const content = snapshot.get(rel);
    if (content !== null) files.set(rel, content);
    return content;
  }

  function exists(rel) {
    if (files.has(rel)) return true;
    if (isDead(rel)) return false;
    if (dirs.has(rel)) return true;
    try {
      fs.lstatSync(absPath(root, rel));
      return true;
    } catch {
      return false;
    }
  }

  function isDir(rel) {
    if (files.has(rel) || isDead(rel)) return false;
    if (dirs.has(rel)) return true;
    if (Array.from(files.keys()).some((k) => k.startsWith(rel + "/"))) return true;
    try {
      return fs.statSync(absPath(root, rel)).isDirectory();
    } catch {
      return false;
    }
  }

  function listFilesUnder(rel) {
    const out = new Set();

    for (const k of files.keys()) {
      if (k.startsWith(rel + "/") && !isDead(k)) out.add(k);
    }

    function walk(abs, relPath) {
      if (isDead(relPath)) return;
      let entries;
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === ".git") continue;
        const r = relPath + "/" + e.name;
        const a = path.join(abs, e.name);
        if (e.isDirectory()) {
          walk(a, r);
        } else if (e.isFile()) {
          if (out.size >= 2000) {
            throw new Error("Directory too large to preview safely. Rename it manually.");
          }
          if (!isDead(r)) out.add(r);
        }
      }
    }

    if (!isDead(rel)) {
      try {
        if (fs.statSync(absPath(root, rel)).isDirectory()) walk(absPath(root, rel), rel);
      } catch {}
    }

    return Array.from(out);
  }

  return {
    snapshot,

    checkpoint() {
      return {
        files: new Map(files),
        dirs: new Set(dirs),
        deadFiles: new Set(deadFiles),
        deadDirs: new Set(deadDirs),
        snapshot: new Map(snapshot),
      };
    },

    restore(cp) {
      files.clear();
      for (const [k, v] of cp.files) files.set(k, v);

      dirs.clear();
      for (const v of cp.dirs) dirs.add(v);

      deadFiles.clear();
      for (const v of cp.deadFiles) deadFiles.add(v);

      deadDirs.clear();
      for (const v of cp.deadDirs) deadDirs.add(v);

      snapshot.clear();
      for (const [k, v] of cp.snapshot) snapshot.set(k, v);
    },

    read,
    readIfExists,
    exists,
    isDir,

    write(rel, content) {
      snap(rel);
      deadFiles.delete(rel);
      files.set(rel, content);
    },

    mkdir(rel) {
      if (files.has(rel)) throw new Error("A file already exists at: " + rel);
      deadDirs.delete(rel);
      dirs.add(rel);
    },

    rename(from, to) {
      if (from === to) throw new Error("Rename source and target are identical.");
      if (to.startsWith(from + "/") || from.startsWith(to + "/")) {
        throw new Error("Overlapping rename paths are not supported.");
      }
      if (!exists(from)) throw new Error("Rename source does not exist: " + from);
      if (exists(to)) throw new Error("Rename target already exists: " + to);

      snap(from);
      snap(to);

      if (isDir(from)) {
        const children = listFilesUnder(from);
        const subdirs = new Set(
          Array.from(dirs).filter((d) => d.startsWith(from + "/"))
        );

        for (const rel of children) {
          const content = read(rel);
          const target = to + rel.slice(from.length);
          files.delete(rel);
          deadFiles.add(rel);
          files.set(target, content);
          snap(target);

          const parts = rel.split("/");
          for (let n = 1; n < parts.length; n++) {
            const d = parts.slice(0, n).join("/");
            if (d.startsWith(from + "/")) subdirs.add(d);
          }
        }

        for (const d of subdirs) {
          dirs.delete(d);
          dirs.add(to + d.slice(from.length));
        }

        dirs.delete(from);
        deadDirs.add(from);
      } else {
        const content = read(from);
        files.delete(from);
        deadFiles.add(from);
        files.set(to, content);
      }
    },

    remove(rel) {
      if (!exists(rel)) throw new Error("Delete target does not exist: " + rel);
      snap(rel);

      if (isDir(rel)) {
        for (const child of listFilesUnder(rel)) {
          snap(child);
          deadFiles.add(child);
          files.delete(child);
        }
        for (const d of Array.from(dirs)) {
          if (d === rel || d.startsWith(rel + "/")) dirs.delete(d);
        }
        deadDirs.add(rel);
      } else {
        deadFiles.add(rel);
        files.delete(rel);
      }
    },
  };
}

/* ---------------- real backend (commit) ---------------- */

function diskBackend(root) {
  const guard = (rel) => {
    absPath(root, rel);
    rejectSymlinks(root, rel);
  };

  return {
    read(rel) {
      const content = diskFile(root, rel);
      if (content === null) throw new Error("File does not exist: " + rel);
      return content;
    },

    readIfExists(rel) {
      return diskFile(root, rel);
    },

    exists(rel) {
      try {
        fs.lstatSync(absPath(root, rel));
        return true;
      } catch {
        return false;
      }
    },

    isDir(rel) {
      try {
        return fs.statSync(absPath(root, rel)).isDirectory();
      } catch {
        return false;
      }
    },

    write(rel, content) {
      guard(rel);
      const p = absPath(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
    },

    mkdir(rel) {
      guard(rel);
      fs.mkdirSync(absPath(root, rel), { recursive: true });
    },

    rename(from, to) {
      guard(from);
      guard(to);
      if (this.exists(to)) throw new Error("Rename target already exists: " + to);
      const target = absPath(root, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(absPath(root, from), target);
    },

    remove(rel) {
      guard(rel);
      const p = absPath(root, rel);
      if (this.isDir(rel)) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    },
  };
}

/* ---------------- executor ---------------- */

function executeOne(op, backend, index) {
  if (op.kind === "dir") {
    backend.mkdir(op.path);
    return { kind: "mkdir", path: op.path, index };
  }

  if (op.kind === "file") {
    const before = backend.readIfExists(op.path);
    const after = withEol(op.body.join("\n"), before);
    backend.write(op.path, after);

    return {
      kind: before === null ? "create" : "write",
      path: op.path,
      before,
      after,
      index,
    };
  }

  if (op.kind === "patch") {
    const before = backend.read(op.path);
    const hunks = parseHunks(op.body);
    let after = before;

    for (let h = 0; h < hunks.length; h++) {
      try {
        after = applyHunk(after, hunks[h]);
      } catch (e) {
        throw new Error(`Hunk ${h + 1}: ${e.message}`);
      }
    }

    if (after === before) {
      throw new Error("Patch would change nothing.");
    }

    const finalText = withEol(after, before);
    backend.write(op.path, finalText);

    return {
      kind: "patch",
      path: op.path,
      before,
      after: finalText,
      hunks: hunks.length,
      index,
    };
  }

  if (op.kind === "rename") {
    backend.rename(op.from, op.to);
    return { kind: "rename", from: op.from, to: op.to, index };
  }

  if (op.kind === "delete") {
    const recursive = backend.isDir(op.path);
    backend.remove(op.path);
    return { kind: recursive ? "rmdir" : "delete", path: op.path, index };
  }

  throw new Error("Unknown operation: " + op.kind);
}

function execute(ops, backend) {
  const log = [];

  for (let index = 0; index < ops.length; index++) {
    try {
      log.push(executeOne(ops[index], backend, index));
    } catch (e) {
      const op = ops[index];
      const label = op.path || `${op.from} -> ${op.to}`;
      throw new Error(`Operation ${index + 1} (${op.kind} ${label}): ${e.message}`);
    }
  }

  return log;
}

function executeTolerant(ops, backend) {
  const results = [];

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const cp = backend.checkpoint ? backend.checkpoint() : null;

    try {
      const item = executeOne(op, backend, index);
      results.push({ index, op, status: "ok", item });
    } catch (e) {
      if (cp) backend.restore(cp);

      const label = op.path || (op.from ? `${op.from} -> ${op.to}` : "unknown");

      results.push({
        index,
        op,
        status: "error",
        message: `${op.kind} ${label}: ${e.message}`,
      });
    }
  }

  const ok = results.filter((r) => r.status === "ok");

  return {
    results,
    log: ok.map((r) => r.item),
    validOps: ok.map((r) => r.op),
    errors: results
      .filter((r) => r.status === "error")
      .map((r) => `#${r.index + 1} ${r.message}`),
  };
}

function preflight(root, snapshot) {
  for (const [rel, original] of snapshot.entries()) {
    const now = diskFile(root, rel);
    if (now !== original) {
      throw new Error(
        `File changed since preview: ${rel}. Copy the response again to re-validate.`
      );
    }
  }
}

module.exports = {
  parseClipboard,
  execute,
  executeTolerant,
  memoryBackend,
  diskBackend,
  preflight,
};