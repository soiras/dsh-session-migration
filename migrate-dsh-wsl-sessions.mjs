#!/usr/bin/env node
/**
 * migrate-dsh-wsl-sessions.mjs
 *
 * Bring sessions that a native `dsh` created *inside WSL* into DSH Desktop's
 * WSL world (the `dsh-wsl-workspace` plugin), so their history stays readable
 * and the agent keeps working in the same Linux directories.
 *
 * ---------------------------------------------------------------------------
 * Why the two stores look different
 * ---------------------------------------------------------------------------
 * Both sides write the same physical format: `session.v4.jsonl.zstd`, a
 * container of concatenated, checksummed Zstandard frames. Frame 0 is exactly
 * one line (the session header); every later frame is one durable batch of
 * JSONL events. What differs between the two stores is the `cwd` field in that
 * header — and everything DSH derives from it:
 *
 *   native WSL dsh : {"cwd":"/home/xxx/proj", ...}
 *   DSH Desktop    : {"cwd":"\\\\wsl.localhost\\Ubuntu-24.04\\home\\xxx\\proj", ...}
 *
 * DSH Desktop is a Windows process, so:
 *   1. the project directory a log lives in is derived from its header cwd
 *        <dshHome>/sessions/--<projectKey(cwd)>--/<sessionId>/
 *      and @deepseek-ai/dsh-session-persistence-jsonl re-derives it on every
 *      read: a log whose header cwd names another path is refused as corrupt
 *      or duplicated.
 *   2. workspace membership is decided by realpath(header.cwd): the registry
 *      keeps a session only when that resolves to the workspace's own path.
 *      On Windows realpath("/home/xxx/proj") answers "<drive>:\\home\\
 *      xxx\\proj" (ENOENT), so a copied WSL session parses fine but is
 *      dropped from every workspace — it never shows up in the sidebar.
 *   3. the execution world comes from the last `agent-preset/selected` event
 *      (the header's agentPreset is only a creation fact). Plugin sessions
 *      record `wsl-standard` / `wsl-ptc` / ...; resuming replays that to mount
 *      the WSL tools. A native WSL session records `standard`, i.e. Windows
 *      tools on Desktop — and the mode picker cannot repair it afterwards,
 *      because `agentPresets.select` refuses a session whose first turn began
 *      (`agent-preset/locked`).
 *
 * So, per session, this script:
 *   1. rewrites header cwd   /home/<...>  ->  \\wsl.localhost\<distro>\home\<...>
 *      (frame 0 is recompressed alone; every event frame is copied byte for byte)
 *   2. appends one frame holding an `agent-preset/selected` event for the WSL
 *      variant of the mode the session last ran in
 *   3. moves the session directory to the project key the new cwd implies
 *   4. registers the session in the workspace record for that directory
 *      (storages/workspace.json), creating the record when it is missing
 * and, once: a full backup, plus a merge of the WSL attachment store so images
 * the migrated sessions reference still resolve.
 *
 * Idempotent: sessions already stored under their cwd's project directory are
 * left alone. `--dry-run` changes nothing.
 *
 * ---------------------------------------------------------------------------
 * Scope, and what it was verified against
 * ---------------------------------------------------------------------------
 * This targets exactly one direction: sessions written by a native `dsh` that
 * lives *inside* a WSL distribution, moved into DSH Desktop on the same
 * Windows machine, where they must keep running in the WSL world. That world
 * is supplied by the **dsh-wsl-workspace** plugin; no other plugin was
 * verified, and nothing here migrates another plugin's data (skins,
 * graph-memory, market, cost-meter, archive-manager, ...).
 *
 * Verified on (one machine, one full copy of the real store, then the real
 * store):
 *   DSH Desktop 0.2.1-rc.5        (the host dsh inside resources/app.asar)
 *   dsh-wsl-workspace 0.7.12      (the plugin that owns the WSL world)
 *   WSL-side dsh 0.2.1-rc.2       (npm -g @deepseek-ai/dsh)
 *   Ubuntu 24.04 on WSL2, Windows 11
 *
 * Internal contracts this script relies on, and checks before touching
 * anything (`workspace.json` unit version 2 is refused if it differs, a
 * session format newer than v4 is refused per-session):
 *   - session storage: <dshHome>/sessions/--<projectKey(cwd)>--/<id>/, a
 *     concatenated-Zstandard-frame container whose first frame is exactly one
 *     header line (v4; older generations are rewritten and left for DSH to
 *     upgrade on open)
 *   - workspace registry: <dshHome>/storages/workspace.json, unit "workspace"
 *     version 2
 *   - execution world: the last `agent-preset/selected` event names a
 *     `wsl-<mode>` variant: wsl-standard / wsl-ptc / wsl-minimal / wsl-cordis
 *
 * Run it with DSH Desktop fully quit (see run-migration.cmd).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const LOG_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;
const PRESET_MARKER = '"agent-preset/selected"';
const WSL_PRESET_RE = /^wsl-/;
const WSL_MODES = new Set(['standard', 'ptc', 'minimal', 'cordis']);
const PRESET_ALIAS = new Map([['code', 'ptc']]);

/* Zstandard container primitives, ported from the harness. */
const ZSTD_MAGIC = 4247762216;
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

const HELP = `migrate-dsh-wsl-sessions.mjs — bring native WSL dsh sessions into DSH Desktop's WSL world

  run-migration.cmd --dry-run          print the plan, change nothing
  run-migration.cmd                    ask, then migrate
  run-migration.cmd --yes              migrate without asking

options:
  --dsh-home <dir>     DSH home (default: %USERPROFILE%\\.dsh)
  --distro <name>      WSL distribution (default: detected)
  --wsl-home <path>    Linux home of the WSL user, e.g. /home/xxx
  --no-preset          keep the recorded mode; do not append a wsl-<mode> selection
  --no-attachments     do not merge <wsl-home>/.dsh/attachments
  --no-backup          skip the backup (not advised)
  --dry-run            plan only
  --check              report the current state and exit
  --reconcile          only (re)register stored sessions that belong to no
                       workspace; moves and rewrites nothing
  --yes                do not ask for confirmation
  --force              continue even if DSH Desktop looks like it is running
  --only <substr>      only sessions whose project key or cwd contains it
  --help               this text
`;

function parseArgs(argv) {
  const opts = {
    dshHome: undefined, distro: undefined, wslHome: undefined,
    attachments: true, backup: true, preset: true, dryRun: false, check: false,
    yes: false, force: false, only: undefined, reconcile: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--dsh-home': opts.dshHome = value(); break;
      case '--distro': opts.distro = value(); break;
      case '--wsl-home': opts.wslHome = value(); break;
      case '--no-preset': opts.preset = false; break;
      case '--no-attachments': opts.attachments = false; break;
      case '--no-backup': opts.backup = false; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--check': opts.check = true; break;
      case '--reconcile': opts.reconcile = true; break;
      case '--yes': case '-y': opts.yes = true; break;
      case '--force': opts.force = true; break;
      case '--only': opts.only = value(); break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

/* ================= DSH path helpers (ported from the harness) ================= */

/** Port of encodeSegment() from @deepseek-ai/dsh-session-persistence-jsonl. */
function encodeSegment(raw) {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** Port of projectKey() from @deepseek-ai/dsh-session-persistence-jsonl. */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/* ============================ zstd container ============================ */

/**
 * Port of scanZstdFrames() from @deepseek-ai/dsh-session-persistence-jsonl:
 * locate complete frames without decompressing them.
 * @returns {{frames: Array<{start: number, end: number}>, tornStart?: number}}
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const headerRest = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < headerRest) return { frames, tornStart: start };
    offset += headerRest;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** The first frame is exactly one header line, newline included. */
function assertHeaderFrame(plaintext) {
  if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1) {
    throw new Error('the first Zstandard frame is not exactly one header line');
  }
}

function* splitBufferLines(payload) {
  let index = 0;
  let next;
  while ((next = payload.indexOf(10, index)) >= 0) {
    yield payload.subarray(index, next);
    index = next + 1;
  }
  if (index < payload.length) yield payload.subarray(index);
}

function compressFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM_OPTIONS);
}

function writeDurable(file, bytes) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/* ================================ reading ================================ */

function listGenerations(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = LOG_RE.exec(entry.name);
    if (match === null) continue;
    found.push({
      version: Number(match[1]),
      zstd: match[2] !== undefined,
      name: entry.name,
      file: path.join(dir, entry.name),
    });
  }
  found.sort((left, right) => right.version - left.version || Number(right.zstd) - Number(left.zstd));
  return found;
}

function readHeaderLine(file) {
  const buffer = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) {
    const end = buffer.indexOf(10);
    return JSON.parse((end === -1 ? buffer : buffer.subarray(0, end)).toString('utf8'));
  }
  const scanned = scanZstdFrames(buffer, 1);
  if (scanned.frames.length === 0) {
    throw new Error(`no complete Zstandard frame${scanned.tornStart === undefined ? '' : ` (incomplete frame at byte ${scanned.tornStart})`}`);
  }
  const plaintext = zlib.zstdDecompressSync(buffer.subarray(scanned.frames[0].start, scanned.frames[0].end));
  assertHeaderFrame(plaintext);
  return JSON.parse(plaintext.subarray(0, plaintext.length - 1).toString('utf8'));
}

/** Event count, last seq and the last selected preset, without holding the log. */
function scanLogTail(file) {
  const buffer = fs.readFileSync(file);
  let eventCount = 0;
  let lastLine;
  let lastPreset;
  const consider = (line) => {
    eventCount += 1;
    lastLine = line;
    if (line.includes(PRESET_MARKER)) {
      try {
        const event = JSON.parse(line.toString('utf8'));
        if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
          lastPreset = event.data.agentPreset;
        }
      } catch { /* an unparsable line is copied verbatim */ }
    }
  };

  let frameCount = 0;
  let tornStart;
  if (file.endsWith('.zstd')) {
    const scanned = scanZstdFrames(buffer);
    frameCount = scanned.frames.length;
    tornStart = scanned.tornStart;
    for (let i = 0; i < scanned.frames.length; i += 1) {
      const frame = scanned.frames[i];
      const plaintext = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end));
      if (i === 0) {
        assertHeaderFrame(plaintext);
        continue;
      }
      for (const line of splitBufferLines(plaintext)) consider(line);
    }
  } else {
    let first = true;
    for (const line of splitBufferLines(buffer)) {
      if (first) { first = false; continue; }
      consider(line);
    }
    frameCount = 1;
  }

  let lastSeq;
  if (lastLine !== undefined) {
    try { lastSeq = JSON.parse(lastLine.toString('utf8'))?.seq; } catch { /* keep undefined */ }
  }
  return { eventCount, lastSeq, lastPreset, frameCount, tornStart };
}

/* ============================== transform ============================== */

/** Linux absolute path -> the UNC spelling the WSL plugin registers. */
function toUnc(posixPath, distro) {
  const trimmed = posixPath.replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return `\\\\wsl.localhost\\${distro}`;
  return `\\\\wsl.localhost\\${distro}\\${trimmed.replace(/\//g, '\\').replace(/^\\+/, '')}`;
}

function windowsKey(value) {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** The WSL variant for a mode id, or undefined when the session already has one. */
function presetTargetFor(lastPreset, headerPreset) {
  const raw = lastPreset ?? headerPreset;
  if (raw === undefined) return 'wsl-standard';
  const id = String(raw).toLowerCase();
  if (WSL_PRESET_RE.test(id)) return undefined;
  const mode = PRESET_ALIAS.get(id) ?? id;
  return WSL_MODES.has(mode) ? `wsl-${mode}` : 'wsl-standard';
}

/** The event line appended as its own final frame. */
function presetEventLine(presetTarget, lastSeq) {
  return JSON.stringify({
    type: 'agent-preset/selected',
    seq: (lastSeq ?? -1) + 1,
    time: Date.now(),
    data: { agentPreset: presetTarget },
  });
}

/**
 * Rewrite frame 0's header cwd and, when asked, append one event frame.
 * Event frames are copied byte for byte.
 */
function rewriteLog({ sourceFile, targetFile, newCwd, appendLine, compressed }) {
  const source = fs.readFileSync(sourceFile);

  if (!compressed) {
    const end = source.indexOf(10);
    const header = JSON.parse((end === -1 ? source : source.subarray(0, end)).toString('utf8'));
    const headerText = JSON.stringify({ ...header, cwd: newCwd });
    const rest = end === -1 ? Buffer.alloc(0) : source.subarray(end + 1);
    const appended = appendLine === undefined ? Buffer.alloc(0) : Buffer.from(`${appendLine}\n`, 'utf8');
    writeDurable(targetFile, Buffer.concat([Buffer.from(`${headerText}\n`, 'utf8'), rest, appended]));
    return { header, headerText, appended: appendLine !== undefined };
  }

  const scanned = scanZstdFrames(source);
  if (scanned.tornStart !== undefined) {
    throw new Error(`the log ends with an incomplete Zstandard frame at byte ${scanned.tornStart}; refusing to rewrite it`);
  }
  if (scanned.frames.length === 0) throw new Error('the log holds no complete Zstandard frame');

  const headerPlain = zlib.zstdDecompressSync(source.subarray(scanned.frames[0].start, scanned.frames[0].end));
  assertHeaderFrame(headerPlain);
  const header = JSON.parse(headerPlain.subarray(0, headerPlain.length - 1).toString('utf8'));
  const headerText = JSON.stringify({ ...header, cwd: newCwd });

  const parts = [compressFrame(`${headerText}\n`)];
  for (let i = 1; i < scanned.frames.length; i += 1) {
    parts.push(source.subarray(scanned.frames[i].start, scanned.frames[i].end));
  }
  if (appendLine !== undefined) parts.push(compressFrame(`${appendLine}\n`));
  writeDurable(targetFile, Buffer.concat(parts));
  return { header, headerText, appended: appendLine !== undefined, sourceFrames: scanned.frames };
}

/** Re-read the rewrite and prove that only frame 0 (plus the appended frame) differs. */
function verifyLog({ sourceFile, targetFile, headerText, appended, compressed }) {
  const problems = [];
  const source = fs.readFileSync(sourceFile);
  const target = fs.readFileSync(targetFile);

  if (!compressed) {
    const lines = target.toString('utf8').split('\n').filter((line) => line.length !== 0);
    if (lines[0] !== headerText) problems.push('header line is not the rewritten header');
    if (appended) {
      const last = JSON.parse(lines[lines.length - 1]);
      if (last?.type !== 'agent-preset/selected') problems.push('the appended line is not an agent-preset/selected event');
    }
    return problems;
  }

  const src = scanZstdFrames(source);
  const dst = scanZstdFrames(target);
  if (dst.tornStart !== undefined) problems.push(`rewritten log ends with an incomplete frame at byte ${dst.tornStart}`);
  const expectedFrames = src.frames.length + (appended ? 1 : 0);
  if (dst.frames.length !== expectedFrames) problems.push(`frame count ${dst.frames.length}, expected ${expectedFrames}`);
  if (dst.frames.length === 0) {
    problems.push('the rewritten log holds no complete frame');
    return problems;
  }

  const headerPlain = zlib.zstdDecompressSync(target.subarray(dst.frames[0].start, dst.frames[0].end));
  if (headerPlain.toString('utf8') !== `${headerText}\n`) problems.push('frame 0 does not hold exactly the rewritten header');

  if (src.frames.length > 1) {
    const lastCopied = src.frames.length - 1;                 // index shared by both sides
    const sourceTail = source.subarray(src.frames[1].start, src.frames[lastCopied].end);
    const targetTail = target.subarray(dst.frames[1].start, dst.frames[lastCopied].end);
    if (!sourceTail.equals(targetTail)) problems.push('event frames were not copied byte for byte');
  }

  if (appended) {
    const last = dst.frames[dst.frames.length - 1];
    const plaintext = zlib.zstdDecompressSync(target.subarray(last.start, last.end));
    const lines = plaintext.toString('utf8').split('\n').filter((line) => line.length !== 0);
    if (lines.length !== 1) problems.push('the appended frame holds more than one line');
    else {
      const event = JSON.parse(lines[0]);
      if (event?.type !== 'agent-preset/selected' || typeof event?.data?.agentPreset !== 'string') {
        problems.push('the appended frame is not an agent-preset/selected event');
      }
      if (!Number.isSafeInteger(event?.seq)) problems.push('the appended event has no integer seq');
    }
  }
  return problems;
}

/* ============================= environment ============================= */

function desktopRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const result = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    return /DeepSeek Harness\.exe/i.test(result);
  } catch {
    return false;
  }
}

/** Installed dsh-wsl-workspace copies under <dshHome>/profiles/<profile>/node_modules. */
function detectWslPlugin(dshHome) {
  const profilesDir = path.join(dshHome, 'profiles');
  const found = [];
  let profiles;
  try {
    profiles = fs.readdirSync(profilesDir);
  } catch {
    return found;
  }
  for (const profile of profiles) {
    const manifest = path.join(profilesDir, profile, 'node_modules', 'dsh-wsl-workspace', 'package.json');
    if (!fs.existsSync(manifest)) continue;
    let version = '?';
    try { version = String(JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? '?'); } catch { /* keep '?' */ }
    found.push({ profile, version });
  }
  return found;
}

function uniq(values) {
  return [...new Set(values)];
}

function wslList() {
  if (process.platform !== 'win32') return [];
  try {
    const raw = execFileSync('wsl.exe', ['-l', '-q'], { windowsHide: true, timeout: 20000 });
    // wsl.exe writes UTF-16LE; a wrapper script may hand back UTF-8.
    const text = raw.length >= 2 && raw[1] === 0 ? raw.toString('utf16le') : raw.toString('utf8');
    return text.split(/\r?\n/).map((line) => line.replace(/\u0000/g, '').trim()).filter((line) => line.length !== 0);
  } catch {
    return [];
  }
}

function distroHasDirectory(distro, posixPath) {
  if (process.platform !== 'win32') return undefined;
  try {
    execFileSync('wsl.exe', ['-d', distro, '-e', 'test', '-d', posixPath], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

function canonicalPathOf(absolutePath) {
  if (process.platform === 'win32') {
    try { return fs.realpathSync.native(absolutePath); } catch { /* fall back to the literal spelling */ }
  }
  return absolutePath;
}

/* ============================== registry ============================== */

function readRegistry(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc?.unit?.name !== 'workspace' || typeof doc.unit.version !== 'number') {
    throw new Error(`${file}: not a workspace registry document (unit.name="workspace")`);
  }
  if (doc.unit.version !== 2) {
    throw new Error(`${file}: workspace registry unit version ${doc.unit.version}; this script knows version 2`);
  }
  doc.global ??= { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] };
  doc.tables ??= {};
  doc.tables.workspaces ??= {};
  doc.global.workspaceIds ??= [];
  doc.global.archivedSessionIds ??= [];
  doc.global.pinnedSessionIds ??= [];
  return doc;
}

/** Register migrated sessions in the workspace records (mutates `doc`). */
function applyRegistryEdits(doc, migrations) {
  const records = doc.tables.workspaces;
  const created = [];
  const attached = [];
  for (const migration of migrations) {
    const key = windowsKey(migration.canonicalPath);
    let recordId = Object.keys(records).find((id) => windowsKey(records[id].path) === key);
    if (recordId === undefined) {
      const now = new Date().toISOString();
      recordId = randomUUID();
      records[recordId] = {
        path: migration.canonicalPath,
        title: path.basename(migration.canonicalPath.replace(/\\+$/, '')) || migration.canonicalPath,
        sessionIds: [],
        createdAt: now,
        updatedAt: now,
      };
      doc.global.workspaceIds.push(recordId);
      created.push(records[recordId]);
    }
    for (const otherId of Object.keys(records)) {
      const other = records[otherId];
      if (otherId !== recordId && other.sessionIds.includes(migration.sessionId)) {
        other.sessionIds = other.sessionIds.filter((id) => id !== migration.sessionId);
      }
    }
    const record = records[recordId];
    if (!record.sessionIds.includes(migration.sessionId)) {
      record.sessionIds.unshift(migration.sessionId);
      attached.push({ sessionId: migration.sessionId, path: record.path });
    }
    record.updatedAt = new Date().toISOString();
  }
  return { created, attached };
}

/** Structural checks the harness itself would run on this document. */
function validateRegistry(doc) {
  const problems = [];
  const records = doc.tables.workspaces;
  const order = new Set(doc.global.workspaceIds);
  if (order.size !== doc.global.workspaceIds.length) problems.push('workspaceIds repeats an id');
  for (const id of order) if (records[id] === undefined) problems.push(`workspaceIds names missing record ${id}`);
  if (doc.global.initialized === true && order.size !== Object.keys(records).length) problems.push('workspaceIds and the record table disagree');
  const paths = new Map();
  const accounted = new Map();
  for (const [id, record] of Object.entries(records)) {
    const key = windowsKey(record.path);
    if (paths.has(key)) problems.push(`path ${record.path} is claimed twice`);
    paths.set(key, id);
    if (!Array.isArray(record.sessionIds)) { problems.push(`record ${id} has no sessionIds array`); continue; }
    for (const sessionId of record.sessionIds) {
      if (accounted.has(sessionId)) problems.push(`session ${sessionId} is accounted twice`);
      accounted.set(sessionId, id);
    }
  }
  return problems;
}

/** Apply registry edits for these sessions, write the file, and report. */
function registerSessions(workspaceFile, migrations) {
  const doc = readRegistry(workspaceFile);
  const report = applyRegistryEdits(doc, migrations);
  const problems = validateRegistry(doc);
  if (problems.length !== 0) return { problems };
  writeFileAtomic(workspaceFile, `${JSON.stringify(doc, null, 2)}\n`);
  return { report, problems };
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.migrating`;
  writeDurable(tmp, Buffer.from(text, 'utf8'));
  fs.renameSync(tmp, file);
}

/* ================================ main ================================ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const out = (line = '') => process.stdout.write(`${line}\n`);
  const dshHome = opts.dshHome !== undefined ? path.resolve(opts.dshHome) : path.join(os.homedir(), '.dsh');
  const sessionsRoot = path.join(dshHome, 'sessions');
  const storages = path.join(dshHome, 'storages');
  const workspaceFile = path.join(storages, 'workspace.json');

  out('');
  out('DSH WSL session migration');
  out('=========================');
  out(`DSH home      : ${dshHome}`);
  out(`DSH Desktop   : ${desktopRunning() ? 'RUNNING — quit it before migrating' : 'not running'}`);
  if (!fs.existsSync(sessionsRoot)) {
    out(`sessions dir  : MISSING (${sessionsRoot})`);
    return 2;
  }
  out(`sessions dir  : ${sessionsRoot}`);
  out(`workspace.json: ${fs.existsSync(workspaceFile) ? workspaceFile : `MISSING (${workspaceFile}) — migrated sessions would stay unlisted`}`);

  /* ---- every stored session's header ---- */
  const projects = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  const found = [];
  const broken = [];
  for (const projectName of projects) {
    const projectDir = path.join(sessionsRoot, projectName);
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(projectDir, entry.name);
      const generations = listGenerations(dir);
      if (generations.length === 0) continue;
      const selected = generations[0];
      let header;
      try {
        header = readHeaderLine(selected.file);
      } catch (error) {
        broken.push({ dir, file: selected.file, error: String(error?.message ?? error) });
        continue;
      }
      if (header === undefined || typeof header !== 'object') {
        broken.push({ dir, file: selected.file, error: 'empty or unreadable header' });
        continue;
      }
      found.push({ projectName, dir, selected, header });
    }
  }

  /* ---- distribution ---- */
  const uncDistros = uniq(found
    .map((entry) => /^\\\\wsl\.localhost\\([^\\]+)\\/.exec(String(entry.header.cwd ?? '')))
    .filter((match) => match !== null)
    .map((match) => match[1]));
  let distro = opts.distro;
  if (distro === undefined) {
    if (uncDistros.length === 1) distro = uncDistros[0];
    else {
      const listed = wslList();
      if (listed.length === 1) distro = listed[0];
    }
  }
  if (distro === undefined) {
    out('');
    out('Cannot decide which WSL distribution to use.');
    if (uncDistros.length > 1) out(`Sessions reference several: ${uncDistros.join(', ')}`);
    else out('No stored session names one, and `wsl -l -q` did not name exactly one.');
    out('Re-run with --distro <name>.');
    return 2;
  }
  out(`distribution  : ${distro}`);
  const plugins = detectWslPlugin(dshHome);
  if (plugins.length === 0) {
    out('plugin        : dsh-wsl-workspace NOT FOUND under profiles/*/node_modules');
    out('                The migrated sessions record a wsl-<mode> preset, and only that');
    out('                plugin provides it: install it first (dsh plugin --profile <name>');
    out('                add dsh-wsl-workspace) and register the WSL workspace, or the');
    out('                sessions will not resume after this migration.');
  } else {
    out(`plugin        : dsh-wsl-workspace ${uniq(plugins.map((entry) => entry.version)).join(', ')} (profile ${plugins.map((entry) => entry.profile).join(', ')})`);
  }
  out('verified with : DSH Desktop 0.2.1-rc.5 + dsh-wsl-workspace 0.7.12 + WSL dsh 0.2.1-rc.2');

  /* ---- plan ---- */
  const plan = [];
  for (const entry of found) {
    const { header } = entry;
    const cwd = header.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      plan.push({ ...entry, action: 'skip', reason: 'header carries no cwd' });
      continue;
    }
    if (opts.only !== undefined && !(entry.projectName.includes(opts.only) || cwd.includes(opts.only))) {
      plan.push({ ...entry, action: 'skip', reason: 'filtered out by --only' });
      continue;
    }
    const posix = cwd.startsWith('/');
    const newCwd = posix ? toUnc(cwd, distro) : cwd;
    const newProjectKey = projectKey(newCwd);
    if (!posix && entry.projectName === newProjectKey) {
      plan.push({ ...entry, action: 'skip', reason: 'already stored under its own cwd project directory' });
      continue;
    }
    if (typeof header.version === 'number' && header.version > 4) {
      plan.push({ ...entry, action: 'error', reason: `session format v${header.version} is newer than this script knows` });
      continue;
    }

    let tail;
    try {
      tail = scanLogTail(entry.selected.file);
    } catch (error) {
      plan.push({ ...entry, action: 'error', reason: `log scan failed: ${String(error?.message ?? error)}` });
      continue;
    }
    if (tail.tornStart !== undefined) {
      plan.push({ ...entry, action: 'error', reason: `the log ends with an incomplete Zstandard frame at byte ${tail.tornStart}` });
      continue;
    }

    const targetDir = path.join(sessionsRoot, newProjectKey, encodeSegment(String(header.id)));
    const targetLog = path.join(targetDir, entry.selected.name);
    const canAppend = opts.preset && (header.version ?? 4) >= 3;
    const presetTarget = canAppend ? presetTargetFor(tail.lastPreset, header.agentPreset) : undefined;
    plan.push({
      ...entry, tail, action: fs.existsSync(targetLog) ? 'conflict' : 'migrate',
      newCwd, newProjectKey, targetDir, targetLog, presetTarget,
      rewrite: posix || presetTarget !== undefined,
    });
  }

  const show = (entry) => {
    out(`  ${entry.header.id}`);
    out(`    cwd    ${entry.header.cwd}`);
    out(`    ->     ${entry.newCwd}`);
    out(`    dir    ${entry.projectName}\\${path.basename(entry.dir)}  ->  ${entry.newProjectKey}\\${path.basename(entry.dir)}`);
    out(`    format v${entry.header.version ?? '?'}   ${entry.tail.eventCount} event(s)   preset ${entry.tail.lastPreset ?? entry.header.agentPreset ?? '(none)'} -> ${entry.presetTarget ?? '(unchanged)'}`);
  };

  const migrating = plan.filter((entry) => entry.action === 'migrate');
  const conflicting = plan.filter((entry) => entry.action === 'conflict');
  const errors = plan.filter((entry) => entry.action === 'error');

  /* Sessions already stored where their cwd says, but accounted by no workspace
     (a workspace registration was deleted afterwards): invisible in the UI
     until they are registered again. */
  const accounted = new Set();
  let registryReadable = false;
  if (fs.existsSync(workspaceFile)) {
    try {
      for (const record of Object.values(readRegistry(workspaceFile).tables.workspaces)) {
        for (const id of record.sessionIds) accounted.add(String(id));
      }
      registryReadable = true;
    } catch (error) {
      out('');
      out(`WARNING workspace.json could not be read: ${String(error?.message ?? error)}`);
    }
  }
  const unregistered = registryReadable
    ? plan.filter((entry) => entry.reason === 'already stored under its own cwd project directory'
        && !accounted.has(String(entry.header.id)))
    : [];

  if (opts.check) {
    out('');
    out(`sessions: ${found.length}`);
    for (const entry of plan) {
      out(`  [${entry.action}] ${path.relative(sessionsRoot, entry.dir)}`);
      out(`      cwd ${entry.header.cwd}${entry.reason === undefined ? '' : `   (${entry.reason})`}`);
    }
    if (broken.length !== 0) {
      out('');
      out(`unreadable logs: ${broken.length}`);
      for (const entry of broken) out(`  ${path.relative(sessionsRoot, entry.file)} — ${entry.error}`);
    }
    return 0;
  }

  out('');
  out(`sessions found : ${found.length}`);
  out(`to migrate     : ${migrating.length}`);
  if (migrating.length !== 0) {
    out('');
    for (const entry of migrating) show(entry);
  }
  const already = plan.filter((entry) => entry.action === 'skip' && entry.reason !== 'filtered out by --only');
  if (already.length !== 0) {
    out('');
    out(`left alone: ${already.length}`);
    for (const entry of already) out(`  ${path.relative(sessionsRoot, entry.dir)} — ${entry.reason}`);
  }
  if (conflicting.length !== 0) {
    out('');
    out(`conflicts (same session id already stored at the target): ${conflicting.length}`);
    for (const entry of conflicting) out(`  ${entry.header.id}  ${path.relative(sessionsRoot, entry.targetLog)}`);
  }
  if (errors.length !== 0) {
    out('');
    out(`unmigratable: ${errors.length}`);
    for (const entry of errors) out(`  ${path.relative(sessionsRoot, entry.dir)} — ${entry.reason}`);
  }
  if (broken.length !== 0) {
    out('');
    out(`unreadable logs (left untouched): ${broken.length}`);
    for (const entry of broken) out(`  ${path.relative(sessionsRoot, entry.file)} — ${entry.error}`);
  }

  if (unregistered.length !== 0) {
    out('');
    out(`stored but in no workspace: ${unregistered.length}`);
    for (const entry of unregistered) out(`  ${entry.header.id}  ${entry.header.cwd}`);
    if (!opts.reconcile) out('  (re-run with --reconcile to register them without moving anything)');
  }

  if (opts.dryRun) {
    out('');
    if (opts.reconcile) out(`dry run: would register ${unregistered.length} session(s) in ${workspaceFile}.`);
    else out('dry run: nothing was changed.');
    return errors.length === 0 && conflicting.length === 0 ? 0 : 1;
  }

  /* ---- reconcile only: register, move nothing ---- */
  if (opts.reconcile) {
    if (migrating.length !== 0) out(`\nnote: ${migrating.length} session(s) still need the full migration; run without --reconcile for those.`);
    if (unregistered.length === 0) {
      out('');
      out('nothing to register.');
      return errors.length === 0 ? 0 : 1;
    }
    if (!fs.existsSync(workspaceFile)) {
      out('');
      out(`workspace.json is missing (${workspaceFile}); register a workspace in DSH Desktop once, then retry.`);
      return 2;
    }
    if (desktopRunning() && !opts.force) {
      out('');
      out('DSH Desktop is still running. Quit it first (tray icon -> Quit, and check');
      out('Task Manager shows no "DeepSeek Harness.exe"), then run this again.');
      return 2;
    }
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`\nRegister ${unregistered.length} session(s) without moving anything? Type "yes" to continue: `)).trim();
      rl.close();
      if (answer.toLowerCase() !== 'yes') {
        out('aborted.');
        return 1;
      }
    }
    const migrations = unregistered.map((entry) => ({
      sessionId: String(entry.header.id),
      canonicalPath: canonicalPathOf(String(entry.header.cwd)),
    }));
    try {
      const written = registerSessions(workspaceFile, migrations);
      if (written.problems.length !== 0) {
        out('');
        out(`workspace.json NOT written: ${written.problems.join('; ')}`);
        return 1;
      }
      out('');
      out(`registered     : ${written.report.attached.length} session(s) in ${written.report.created.length} new workspace(s)`);
      for (const record of written.report.created) out(`                 + ${record.title}   ${record.path}`);
      out('');
      out('next           : start DSH Desktop; the sessions above are back in the sidebar.');
      return 0;
    } catch (error) {
      out('');
      out(`workspace.json FAIL: ${String(error?.message ?? error)}`);
      return 1;
    }
  }

  if (migrating.length === 0) {
    out('');
    out(conflicting.length === 0 ? 'nothing to do.' : 'nothing to migrate (see conflicts above).');
    return errors.length === 0 && conflicting.length === 0 ? 0 : 1;
  }

  /* ---- guards ---- */
  if (desktopRunning() && !opts.force) {
    out('');
    out('DSH Desktop is still running. Quit it first (tray icon -> Quit, and check');
    out('Task Manager shows no "DeepSeek Harness.exe"), then run this again.');
    return 2;
  }

  const usable = [];
  for (const entry of migrating) {
    const verdict = distroHasDirectory(distro, String(entry.header.cwd));
    if (verdict === false) {
      out('');
      out(`WARNING ${entry.header.cwd} does not exist inside ${distro};`);
      out(`        ${entry.header.id} is left where it is (no workspace could own a missing cwd).`);
      entry.action = 'error';
      entry.reason = 'cwd does not exist inside the distribution';
    } else {
      usable.push(entry);
    }
  }
  if (usable.length === 0) {
    out('');
    out('nothing left to do.');
    return 1;
  }

  /* ---- confirm ---- */
  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nMigrate ${usable.length} session(s)? Type "yes" to continue: `)).trim();
    rl.close();
    if (answer.toLowerCase() !== 'yes') {
      out('aborted.');
      return 1;
    }
  }

  /* ---- backup ---- */
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const sessionsBackup = path.join(dshHome, `sessions.bak-${stamp}`);
  const registryBackup = path.join(storages, `workspace.json.bak-${stamp}`);
  if (opts.backup) {
    out('');
    out(`backup         : ${sessionsBackup}`);
    fs.cpSync(sessionsRoot, sessionsBackup, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
    if (fs.existsSync(workspaceFile)) {
      fs.copyFileSync(workspaceFile, registryBackup);
      out(`               : ${registryBackup}`);
    }
  }

  /* ---- migrate ---- */
  out('');
  const migrations = [];
  const failures = [];
  for (const entry of usable) {
    try {
      fs.mkdirSync(entry.targetDir, { recursive: true });
      const tmp = path.join(entry.targetDir, `${entry.selected.name}.migrating`);
      fs.rmSync(tmp, { force: true });
      const appendLine = entry.presetTarget === undefined ? undefined : presetEventLine(entry.presetTarget, entry.tail.lastSeq);
      const facts = rewriteLog({
        sourceFile: entry.selected.file,
        targetFile: tmp,
        newCwd: entry.newCwd,
        appendLine,
        compressed: entry.selected.zstd,
      });
      const problems = verifyLog({
        sourceFile: entry.selected.file,
        targetFile: tmp,
        headerText: facts.headerText,
        appended: facts.appended,
        compressed: entry.selected.zstd,
      });
      if (problems.length !== 0) throw new Error(`verification failed: ${problems.join('; ')}`);
      fs.renameSync(tmp, entry.targetLog);

      for (const other of fs.readdirSync(entry.dir)) {
        const from = path.join(entry.dir, other);
        if (from === entry.selected.file) continue;
        if (other === 'session.lock') { fs.rmSync(from, { force: true }); continue; }
        const to = path.join(entry.targetDir, other);
        if (fs.existsSync(to)) throw new Error(`target already holds ${other}`);
        fs.renameSync(from, to);
      }
      fs.rmSync(entry.selected.file, { force: true });
      try { fs.rmdirSync(entry.dir); } catch { /* a stray file keeps the old dir around */ }

      // Older generations kept beside the current one must describe the same
      // cwd, or the directory's identity would disagree with itself.
      for (const generation of listGenerations(entry.targetDir)) {
        if (generation.name === entry.selected.name) continue;
        const file = generation.file;
        const tmpGeneration = `${file}.migrating`;
        const generationFacts = rewriteLog({
          sourceFile: file,
          targetFile: tmpGeneration,
          newCwd: entry.newCwd,
          appendLine: undefined,
          compressed: generation.zstd,
        });
        const generationProblems = verifyLog({
          sourceFile: file,
          targetFile: tmpGeneration,
          headerText: generationFacts.headerText,
          appended: false,
          compressed: generation.zstd,
        });
        if (generationProblems.length !== 0) {
          fs.rmSync(tmpGeneration, { force: true });
          throw new Error(`verification failed for ${generation.name}: ${generationProblems.join('; ')}`);
        }
        fs.renameSync(tmpGeneration, file);
      }

      migrations.push({ sessionId: String(entry.header.id), canonicalPath: canonicalPathOf(entry.newCwd) });
      out(`  ok    ${entry.header.id}  v${entry.header.version ?? '?'}, ${entry.tail.eventCount} event(s)${facts.appended ? `, +${entry.presetTarget}` : ''}`);
    } catch (error) {
      fs.rmSync(path.join(entry.targetDir, `${entry.selected.name}.migrating`), { force: true });
      failures.push({ id: String(entry.header.id), error: String(error?.message ?? error) });
      out(`  FAIL  ${entry.header.id}  ${String(error?.message ?? error)}`);
    }
  }

  /* ---- registry ---- */
  let registryReport;
  if (migrations.length !== 0 && fs.existsSync(workspaceFile)) {
    try {
      const written = registerSessions(workspaceFile, migrations);
      if (written.problems.length !== 0) {
        failures.push({ id: '(workspace.json)', error: written.problems.join('; ') });
        out(`  FAIL  workspace.json not written: ${written.problems.join('; ')}`);
      } else {
        registryReport = written.report;
        out(`  ok    workspace.json: ${written.report.created.length} workspace(s) created, ${written.report.attached.length} session(s) registered`);
      }
    } catch (error) {
      failures.push({ id: '(workspace.json)', error: String(error?.message ?? error) });
      out(`  FAIL  workspace.json: ${String(error?.message ?? error)}`);
    }
  }

  /* ---- attachments ---- */
  let attachmentsReport;
  if (opts.attachments && migrations.length !== 0 && process.platform === 'win32') {
    const wslHome = opts.wslHome ?? inferWslHome(found.map((entry) => entry.header.cwd));
    if (wslHome === undefined) {
      attachmentsReport = 'skipped: could not infer the WSL home (pass --wsl-home)';
    } else {
      const source = path.join(toUnc(wslHome, distro), '.dsh', 'attachments');
      const target = path.join(dshHome, 'attachments');
      if (!fs.existsSync(source)) {
        attachmentsReport = `skipped: ${source} not found`;
      } else {
        try {
          fs.cpSync(source, target, { recursive: true, errorOnExist: false, force: false });
          attachmentsReport = `${source}  ->  ${target}`;
        } catch (error) {
          attachmentsReport = `failed: ${String(error?.message ?? error)}`;
        }
      }
    }
  }

  /* ---- drop the emptied project directories ---- */
  for (const projectName of projects) {
    const projectDir = path.join(sessionsRoot, projectName);
    if (!fs.existsSync(projectDir)) continue;
    try {
      if (fs.readdirSync(projectDir).length === 0) fs.rmdirSync(projectDir);
    } catch { /* not empty or already gone */ }
  }

  /* ---- summary ---- */
  out('');
  out('result');
  out('------');
  out(`migrated       : ${migrations.length}`);
  if (registryReport !== undefined) {
    out(`workspaces     : ${registryReport.created.length} created, ${registryReport.attached.length} session(s) registered`);
    for (const record of registryReport.created) out(`                 + ${record.title}   ${record.path}`);
  }
  if (attachmentsReport !== undefined) out(`attachments    : ${attachmentsReport}`);
  out(`failed         : ${failures.length}`);
  for (const failure of failures) out(`                 ${failure.id} — ${failure.error}`);
  out('');
  if (opts.backup) {
    out(`rollback       : quit DSH Desktop, delete ${sessionsRoot}, then restore`);
    out(`                 ${sessionsBackup}  and  ${registryBackup}`);
  }
  out('next           : start DSH Desktop. Each migrated session now belongs to the');
  out('                 WSL workspace of its own directory and resumes with the WSL');
  out('                 variant of the mode it last ran in (pick it from Workspaces).');
  return failures.length === 0 ? 0 : 1;
}

/** Best-effort WSL home, from the Linux / UNC cwds we saw. */
function inferWslHome(cwds) {
  const candidates = [];
  for (const cwd of cwds) {
    if (typeof cwd !== 'string') continue;
    const posix = cwd.startsWith('\\\\wsl.localhost\\')
      ? cwd.replace(/^\\\\wsl\.localhost\\[^\\]+/, '').replace(/\\/g, '/')
      : cwd;
    if (!posix.startsWith('/')) continue;
    const match = /^(\/home\/[^/]+|\/root|\/Users\/[^/]+)/.exec(posix);
    if (match !== null) candidates.push(match[1]);
  }
  const unique = uniq(candidates);
  return unique.length === 1 ? unique[0] : undefined;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`migration failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
