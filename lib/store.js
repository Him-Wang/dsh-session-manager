/**
 * Pure filesystem side of dsh-session-manager.
 *
 * Everything here is deliberately independent of the running DSH services: the
 * session log layout (one project directory per cwd, one directory per session)
 * and the projection cache are the same on-disk contracts the JSONL backend
 * documents, and reading them needs no host dependency. Workspace registration
 * changes still go through the official controller (see lib/index.js) so the
 * live registry and the durable file never disagree.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Root of the DSH data directory (``~/.dsh`` unless the environment overrides it). */
export function resolveHome(config = {}) {
  const configured = config.home;
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured);
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

export function paths(home, config = {}) {
  return {
    home,
    sessions: path.join(home, 'sessions'),
    projection: path.join(home, 'storages', 'session_projcache', 'sessions'),
    workspaceFile: path.join(home, 'storages', 'workspace.json'),
    trash: path.resolve(config.trashDir || path.join(home, 'trash')),
  };
}

/* ----------------------------------------------------------------------------
 * Path encoding — kept byte-for-byte compatible with the JSONL backend so a
 * session id always maps to exactly the directory that backend wrote.
 * -------------------------------------------------------------------------- */

/** Escape an arbitrary string into one filesystem-safe segment. */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Reverse {@link encodeSegment}; returns the input when it is not an encoding. */
export function decodeSegment(name) {
  if (typeof name !== 'string' || !name.includes('~')) return name;
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch !== '~') {
      out += ch;
      continue;
    }
    const hex = name.slice(i + 1, i + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return name;
    out += String.fromCharCode(parseInt(hex, 16));
    i += 4;
  }
  return out;
}

/** Readable project directory name for a cwd (mirrors the JSONL backend). */
export function projectKey(cwd) {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/* ---------------------------------------------------------------------------- */

async function readdirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Recursive byte size + newest mtime of a directory. */
export async function measure(dir) {
  let bytes = 0;
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(target);
          continue;
        }
        const stat = await fsp.stat(target);
        bytes += stat.size;
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        /* a file removed mid-walk simply does not count */
      }
    }
  }
  return { bytes, newest };
}

export async function measureFolder(dir) {
  if (!fs.existsSync(dir)) return 0;
  return (await measure(dir)).bytes;
}

function titleFromCache(cache) {
  const rows = cache?.record?.rows;
  const title = rows?.title?.val;
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined;
}

/** Durable workspace registry state, read straight from workspace.json. */
export function readWorkspaces(file) {
  const data = readJsonSafe(file);
  const global = data?.global ?? {};
  const table = data?.tables?.workspaces ?? {};
  const list = [];
  for (const [id, row] of Object.entries(table)) {
    if (!row || typeof row !== 'object') continue;
    list.push({
      id,
      title: typeof row.title === 'string' ? row.title : id,
      path: typeof row.path === 'string' ? row.path : '',
      sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds : [],
      isDefault: global.defaultWorkspaceId === id,
    });
  }
  return {
    data,
    workspaces: list,
    archived: new Set(Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []),
    pinned: new Set(Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : []),
  };
}

/**
 * Enumerate every stored session visible on disk.
 * @returns rows carrying identity, title, project, size and activity facts.
 */
export async function listSessions(p) {
  const registry = readWorkspaces(p.workspaceFile);
  const byProjectKey = new Map();
  for (const workspace of registry.workspaces) {
    if (workspace.path) byProjectKey.set(projectKey(workspace.path), workspace);
  }
  const rows = [];
  for (const projectEntry of await readdirSafe(p.sessions)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(p.sessions, projectEntry.name);
    for (const sessionEntry of await readdirSafe(projectDir)) {
      if (!sessionEntry.isDirectory()) continue;
      const id = decodeSegment(sessionEntry.name);
      const dir = path.join(projectDir, sessionEntry.name);
      const cache = readJsonSafe(path.join(p.projection, `${encodeSegment(id)}.json`));
      const identity = cache?.record?.identity ?? {};
      const { bytes, newest } = await measure(dir);
      const workspace = byProjectKey.get(projectEntry.name);
      rows.push({
        id,
        dir,
        project: projectEntry.name,
        title: titleFromCache(cache) ?? id,
        cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
        createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : undefined,
        updatedAt: newest,
        bytes,
        archived: registry.archived.has(id),
        pinned: registry.pinned.has(id),
        workspaceId: workspace ? workspace.id : null,
      });
    }
  }
  rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { rows, registry };
}

/** Rewrite only the session-id arrays; every other byte stays as parsed. */
function stripSessionIds(data, ids) {
  const wanted = new Set(ids);
  let changed = false;
  const global = data?.global ?? {};
  for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
    if (!Array.isArray(global[key])) continue;
    const next = global[key].filter(id => !wanted.has(id));
    if (next.length !== global[key].length) {
      global[key] = next;
      changed = true;
    }
  }
  const table = data?.tables?.workspaces ?? {};
  for (const row of Object.values(table)) {
    if (!row || !Array.isArray(row.sessionIds)) continue;
    const next = row.sessionIds.filter(id => !wanted.has(id));
    if (next.length !== row.sessionIds.length) {
      row.sessionIds = next;
      changed = true;
    }
  }
  return changed;
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.session-manager.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/** Remove ids from the workspace registry's session lists. */
export function forgetSessions(p, ids) {
  const data = readJsonSafe(p.workspaceFile);
  if (data === undefined) return false;
  if (!stripSessionIds(data, ids)) return false;
  writeJsonAtomic(p.workspaceFile, data);
  return true;
}

/** Stable assertion that a directory really is the one we enumerated. */
function assertInsideSessions(root, dir) {
  const relative = path.relative(root, dir);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('拒绝操作会话根目录之外的位置');
  }
}

/**
 * Permanently delete one enumerated session: its log directory and the
 * projection-cache row that feeds the sidebar title.
 */
export async function removeSession(p, row, { busyWindowMs = 30000 } = {}) {
  assertInsideSessions(p.sessions, row.dir);
  if (path.basename(row.dir) !== encodeSegment(row.id) && path.basename(row.dir) !== row.id) {
    throw new Error('会话目录与 id 不匹配，已停止');
  }
  const age = Date.now() - (row.updatedAt ?? 0);
  if (busyWindowMs > 0 && age < busyWindowMs) {
    const seconds = Math.ceil((busyWindowMs - age) / 1000);
    throw new Error(`该会话 ${seconds} 秒前仍有写入，可能仍在使用；请稍后再试，或先切换到其他会话`);
  }
  await fsp.rm(row.dir, { recursive: true, force: true });
  try {
    await fsp.rm(path.join(p.projection, `${encodeSegment(row.id)}.json`), { force: true });
  } catch {
    /* the cache row is rebuilt on demand */
  }
  return row.bytes;
}

/**
 * Move a workspace folder into the DSH trash directory. Never deletes bytes and
 * refuses any folder the running process could be standing in.
 */
export async function trashFolder(p, folder, { protectedPaths = [] } = {}) {
  if (typeof folder !== 'string' || folder.trim() === '') throw new Error('工作区没有文件夹路径');
  const target = path.resolve(folder);
  if (!fs.existsSync(target)) throw new Error('文件夹不存在，无需删除');
  const parsed = path.parse(target);
  if (target === parsed.root) throw new Error('拒绝操作磁盘根目录');
  if (path.relative(target, p.home) === '' || !path.relative(target, p.home).startsWith('..')) {
    throw new Error('拒绝把 DSH 数据目录移入回收站');
  }
  for (const guarded of protectedPaths) {
    if (typeof guarded !== 'string' || guarded === '') continue;
    const relative = path.relative(target, path.resolve(guarded));
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error(`文件夹正在被 DSH 使用（${guarded} 在它里面），无法移动；请先关闭相关会话或退出 DSH`);
    }
  }
  await fsp.mkdir(p.trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let destination = path.join(p.trash, `${stamp}-${path.basename(target)}`);
  for (let n = 2; fs.existsSync(destination) && n < 1000; n++) {
    destination = path.join(p.trash, `${stamp}-${path.basename(target)}-${n}`);
  }
  try {
    await fsp.rename(target, destination);
  } catch (error) {
    throw new Error(`移动文件夹失败（${error.code || error.message}）；请先在资源管理器里关闭占用它的程序再试`);
  }
  return destination;
}

/** Trash entries, newest first, with their byte size. */
export async function listTrash(p) {
  const entries = [];
  for (const entry of await readdirSafe(p.trash)) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(p.trash, entry.name);
    const { bytes, newest } = await measure(dir);
    entries.push({ name: entry.name, dir, bytes, movedAt: newest });
  }
  entries.sort((a, b) => (b.movedAt ?? 0) - (a.movedAt ?? 0));
  return entries;
}

export async function purgeTrashEntry(p, name) {
  if (typeof name !== 'string' || name === '' || name !== path.basename(name) || name.startsWith('..')) {
    throw new Error('回收站条目名无效');
  }
  const dir = path.join(p.trash, name);
  const relative = path.relative(p.trash, dir);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(dir)) {
    throw new Error('回收站里没有这个条目');
  }
  await fsp.rm(dir, { recursive: true, force: true });
  return true;
}
