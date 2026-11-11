/**
 * Standalone checks for lib/store.js — runs under plain Node, no DSH needed.
 * Builds a throwaway home directory that copies the JSONL backend's layout and
 * asserts every destructive path before the plugin is ever installed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  decodeSegment, encodeSegment, forgetSessions, listSessions, listTrash, paths,
  projectKey, purgeTrashEntry, readWorkspaces, rememberSession, removeSession,
  restoreTrashEntry, trashFolder, trashSession,
} from '../lib/store.js';

const scratch = await fsp.mkdtemp(path.join(import.meta.dirname, '.tmp-'));
const root = path.join(scratch, 'home');
fs.mkdirSync(root, { recursive: true });
const home = path.join(root, 'home');
const cwd = path.join(root, 'project');
const p = paths(home);

const uuid = '0d8011b7-1111-4222-8333-944455556666';
const second = 'session-51c02c4a-2222-4333-8444-955566667777';
const project = projectKey(cwd);

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function seedSession(id, { title, cwd: sessionCwd = cwd, ageMs = 10 * 60_000 } = {}) {
  const dir = path.join(p.sessions, project, encodeSegment(id));
  write(path.join(dir, 'session.v4.jsonl.zstd'), 'x'.repeat(2048));
  const cache = path.join(p.projection, `${encodeSegment(id)}.json`);
  write(cache, JSON.stringify({
    version: 4,
    record: { identity: { cwd: sessionCwd, createdAt: Date.now() - ageMs }, rows: { title: { val: title } } },
  }));
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(path.join(dir, 'session.v4.jsonl.zstd'), stamp, stamp);
  return dir;
}

seedSession(uuid, { title: '你好，世界' });
seedSession(second, { title: 'Second session' });
const workspaceDir = path.join(root, 'workdir');
fs.mkdirSync(workspaceDir, { recursive: true });
write(path.join(workspaceDir, 'keep.txt'), 'stay');

write(p.workspaceFile, JSON.stringify({
  unit: 2,
  global: {
    initialized: true,
    defaultWorkspaceId: 'ws-1',
    workspaceIds: ['ws-1'],
    archivedSessionIds: [second, 'ghost'],
    pinnedSessionIds: [uuid],
  },
  tables: {
    workspaces: {
      'ws-1': { title: 'demo', path: cwd, sessionIds: [uuid, second], createdAt: 0, updatedAt: 0 },
      'ws-2': { title: 'other', path: workspaceDir, sessionIds: [], createdAt: 0, updatedAt: 0 },
    },
  },
}, null, 2));

/* ---------------------------------------------------------------- encoding */

assert.equal(encodeSegment(uuid), uuid, 'plain ids survive unchanged');
assert.equal(encodeSegment('a/b'), 'a~002Fb');
assert.equal(decodeSegment(encodeSegment('a/~b\\c')), 'a/~b\\c', 'escape round-trips');
assert.equal(decodeSegment('plain'), 'plain');
assert.equal(projectKey('C:\\Users\\x\\proj'), '--C-Users-x-proj--');
assert.equal(projectKey('/home/x'), '--home-x--');

/* ------------------------------------------------------------------ listing */

const { rows, registry } = await listSessions(p);
assert.equal(rows.length, 2, 'both sessions found');
assert.equal(registry.workspaces.length, 2);
const first = rows.find(row => row.id === uuid);
assert.equal(first.title, '你好，世界', 'title comes from the projection cache');
assert.equal(first.cwd, cwd);
assert.equal(first.pinned, true);
assert.equal(first.workspaceId, 'ws-1');
assert.equal(first.archived, false);
assert.ok(first.bytes >= 2048, 'reports log size');
assert.ok(first.updatedAt > 0);
const other = rows.find(row => row.id === second);
assert.equal(other.archived, true);
assert.equal(rows[0].updatedAt >= rows[1].updatedAt, true, 'newest activity first');

/* -------------------------------------------------------------- busy guard */

await assert.rejects(() => removeSession(p, first, { busyWindowMs: 60 * 60_000 }), /仍在写入|仍在使用/,
  'a session written moments ago is refused');
assert.ok(fs.existsSync(first.dir), 'refused delete leaves the log in place');

/* ----------------------------------------------------------- delete a row */

const freed = await removeSession(p, { ...first, updatedAt: 0 }, { busyWindowMs: 30_000 });
assert.ok(freed >= 2048, 'reports freed bytes');
assert.equal(fs.existsSync(first.dir), false, 'log directory removed');
assert.equal(fs.existsSync(path.join(p.projection, `${encodeSegment(uuid)}.json`)), false, 'cache row removed');

await assert.rejects(
  () => removeSession(p, { ...first, dir: path.join(root, 'outside', encodeSegment(uuid)), updatedAt: 0 }, {}),
  /会话根目录/,
  'refuses a directory outside the sessions root',
);
await assert.rejects(
  () => removeSession(p, { ...first, dir: path.join(p.sessions, project, 'not-my-dir'), id: uuid, updatedAt: 0 }, {}),
  /不匹配/,
  'refuses a directory that does not match the id',
);

/* ----------------------------------------------------- registry bookkeeping */

assert.equal(forgetSessions(p, [uuid, second]), true);
const after = readWorkspaces(p.workspaceFile);
assert.deepEqual(after.workspaces.find(w => w.id === 'ws-1').sessionIds, [], 'workspace membership cleared');
assert.deepEqual([...after.archived], ['ghost'], 'archived ids pruned, unrelated kept');
assert.deepEqual([...after.pinned], [], 'pinned ids pruned');
const raw = JSON.parse(fs.readFileSync(p.workspaceFile, 'utf8'));
assert.equal(raw.unit, 2, 'unrelated fields preserved');
assert.equal(raw.tables.workspaces['ws-2'].path, workspaceDir, 'other workspaces untouched');
assert.equal(fs.readFileSync(p.workspaceFile, 'utf8').endsWith('\n'), true, 'file ends with a newline');
assert.equal(forgetSessions(p, ['never-seen']), false, 'no write when nothing matched');

/* ----------------------------------------------------------------- trash */

await assert.rejects(() => trashFolder(p, workspaceDir, { protectedPaths: [path.join(workspaceDir, 'inner')] }),
  /正在被 DSH 使用/, 'a protected path inside the folder blocks the move');
await assert.rejects(() => trashFolder(p, home, {}), /DSH 数据目录/, 'never trashes the DSH home');
await assert.rejects(() => trashFolder(p, path.parse(workspaceDir).root, {}), /磁盘根目录/, 'never trashes a drive root');
await assert.rejects(() => trashFolder(p, path.join(root, 'missing'), {}), /不存在/, 'missing folders are not errors to act on');

const moved = await trashFolder(p, workspaceDir, { protectedPaths: [cwd] });
assert.ok(moved.startsWith(p.trash), 'lands inside the trash');
assert.equal(fs.existsSync(workspaceDir), false, 'original location is free');
assert.equal(fs.existsSync(path.join(moved, 'keep.txt')), true, 'contents move intact');
assert.match(path.basename(moved), /^\d{4}-\d{2}-\d{2}T.*-workdir$/, 'timestamped name');

const trash = await listTrash(p);
assert.equal(trash.length, 1);
assert.equal(trash[0].name, path.basename(moved));
assert.ok(trash[0].bytes > 0);

await assert.rejects(() => purgeTrashEntry(p, '../escape'), /无效/, 'rejects traversal');
await assert.rejects(() => purgeTrashEntry(p, 'nope'), /没有这个条目/, 'rejects unknown entries');
assert.equal(await purgeTrashEntry(p, path.basename(moved)), true);
assert.equal(fs.existsSync(moved), false, 'purge really deletes');
assert.equal((await listTrash(p)).length, 0);

/* ---------------------------------------------- trash a session, then restore */

const parked = await trashSession(p, { ...other, updatedAt: 0 }, { busyWindowMs: 30_000 });
assert.match(parked.name, /-session-/, 'trash entry names its kind');
assert.equal(fs.existsSync(other.dir), false, 'log left the sessions tree');
assert.equal(fs.existsSync(path.join(p.trash, parked.name, 'session', 'session.v4.jsonl.zstd')), true, 'payload kept intact');
assert.equal(fs.existsSync(path.join(p.projection, `${encodeSegment(second)}.json`)), false, 'cache travels with the log');
const parkedEntry = (await listTrash(p)).find(entry => entry.kind === 'session');
assert.equal(parkedEntry.id, second);
assert.equal(parkedEntry.title, 'Second session');

const back = await restoreTrashEntry(p, parked.name);
assert.equal(back.archived, true, 'archive flag survives the round trip');
assert.equal(fs.existsSync(path.join(other.dir, 'session.v4.jsonl.zstd')), true, 'log is back in its project directory');
assert.equal(fs.existsSync(path.join(p.projection, `${encodeSegment(second)}.json`)), true, 'cache row is back');
assert.equal(fs.existsSync(path.join(p.trash, parked.name)), false, 'consumed entry is gone');
assert.equal(rememberSession(p, back), true);
assert.equal(readWorkspaces(p.workspaceFile).archived.has(second), true, 'archive membership restored');

await assert.rejects(() => restoreTrashEntry(p, parked.name), /没有这个条目/, 'a consumed entry cannot be restored twice');

const parkedAgain = await trashSession(p, { ...other, updatedAt: 0 }, { busyWindowMs: 30_000 });
fs.mkdirSync(other.dir, { recursive: true });
await assert.rejects(() => restoreTrashEntry(p, parkedAgain.name), /已经有同名会话/, 'never overwrites a live session');
await fsp.rm(other.dir, { recursive: true, force: true });
await purgeTrashEntry(p, parkedAgain.name);
assert.equal(fs.existsSync(path.join(p.trash, parkedAgain.name)), false, 'a parked session can be purged for good');

await fsp.rm(root, { recursive: true, force: true });
console.log('store.js: all checks passed');
