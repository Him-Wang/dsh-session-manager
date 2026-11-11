/**
 * Standalone checks for lib/index.js — a fake Cordis context plus a real HTTP
 * server, so the guards and payloads are exercised without DSH running.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { apply, inject, name } from '../lib/index.js';
import { encodeSegment, paths, projectKey } from '../lib/store.js';

assert.equal(name, 'dsh-session-manager');
assert.deepEqual(inject, ['webServer', 'workspaceController']);

const scratch = await fsp.mkdtemp(path.join(import.meta.dirname, '.tmp-'));
const root = path.join(scratch, 'home');
fs.mkdirSync(root, { recursive: true });
const home = path.join(root, 'home');
const cwd = path.join(root, 'project');
const trashDir = path.join(root, 'recycle');
const p = paths(home, { trashDir });
const project = projectKey(cwd);
const sessionId = '0d8011b7-aaaa-4bbb-8ccc-dddd55556666';

fs.mkdirSync(path.join(p.sessions, project, encodeSegment(sessionId)), { recursive: true });
fs.writeFileSync(path.join(p.sessions, project, encodeSegment(sessionId), 'session.v4.jsonl.zstd'), 'log');
const old = new Date(Date.now() - 3_600_000);
fs.utimesSync(path.join(p.sessions, project, encodeSegment(sessionId), 'session.v4.jsonl.zstd'), old, old);
fs.mkdirSync(p.projection, { recursive: true });
fs.writeFileSync(path.join(p.projection, `${encodeSegment(sessionId)}.json`),
  JSON.stringify({ record: { identity: { cwd }, rows: { title: { val: '要被删掉的会话' } } } }));
const folder = cwd;
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'a.txt'), 'data');
fs.mkdirSync(path.dirname(p.workspaceFile), { recursive: true });
fs.writeFileSync(p.workspaceFile, JSON.stringify({
  global: { defaultWorkspaceId: 'ws-1', workspaceIds: ['ws-1'], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { 'ws-1': { title: 'demo', path: folder, sessionIds: [sessionId] } } },
}, null, 2));

const routes = new Map();
const controllerCalls = [];
const ctx = {
  inject(names, fn) {
    assert.deepEqual(names, ['webServer']);
    fn({
      effect(run) {
        const dispose = run();
        assert.equal(typeof dispose, 'function', 'effect returns a disposer');
        return dispose;
      },
      webServer: {
        register(route) {
          assert.equal(route.kind, 'exact');
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    });
  },
  workspaceController: {
    async delete(request) {
      controllerCalls.push(request);
      return { ok: true };
    },
  },
};

apply(ctx, { home, trashDir, busyWindowMs: 0 });
assert.deepEqual([...routes.keys()].sort(), [
  '/dsh-session-manager/delete-sessions',
  '/dsh-session-manager/delete-workspace',
  '/dsh-session-manager/overview',
  '/dsh-session-manager/purge-trash',
  '/dsh-session-manager/restore-session',
], 'all five routes registered');

const server = http.createServer((request, response) => {
  const handler = routes.get(request.url.split('?')[0]);
  if (handler === undefined) {
    response.writeHead(404).end();
    return;
  }
  handler(request, response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(op, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}/dsh-session-manager/${op}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? undefined : JSON.parse(text) };
}

try {
  /* ------------------------------------------------------------------ read */

  const overview = await call('overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.ok, true);
  assert.equal(overview.json.sessions.length, 1);
  assert.equal(overview.json.sessions[0].title, '要被删掉的会话');
  assert.equal('dir' in overview.json.sessions[0], false, 'internal paths are not exposed');
  assert.equal(overview.json.totals.sessions, 1);
  assert.equal(overview.json.workspaces.length, 1);
  assert.equal(overview.json.workspaces[0].exists, true);
  assert.equal(overview.json.workspaces[0].inUse, false);
  assert.equal(overview.json.trashDir, path.resolve(trashDir));

  /* ---------------------------------------------------------------- guards */

  const crossOrigin = await call('overview', { headers: { origin: 'https://evil.example' } });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.json.error, /DSH 页面/);

  const noFlag = await call('delete-sessions', { method: 'POST', body: { ids: [sessionId] } });
  assert.equal(noFlag.status, 403);
  assert.match(noFlag.json.error, /请求标记/);

  const wrongMethod = await call('delete-sessions', { method: 'GET' });
  assert.equal(wrongMethod.status, 405);

  const wrongType = await fetch(`${base}/dsh-session-manager/delete-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-dsh-session-manager': '1' },
    body: '{"ids":[]}',
  });
  assert.equal(wrongType.status, 400, 'rejects non-JSON bodies');

  const empty = await call('delete-sessions', { method: 'POST', body: { ids: [] }, headers: { 'x-dsh-session-manager': '1' } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /没有选择/);

  /* -------------------------------------------------------- delete sessions */

  const deleted = await call('delete-sessions', {
    method: 'POST',
    body: { ids: [sessionId, sessionId, 'no-such-id'] },
    headers: { 'x-dsh-session-manager': '1' },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.ok, false, 'partial failure is reported as not-ok');
  assert.deepEqual(deleted.json.removed, [sessionId], 'duplicate ids collapse');
  assert.equal(deleted.json.mode, 'trash', 'deletion is reversible by default');
  assert.equal(deleted.json.results.filter(r => r.ok).length, 1);
  assert.equal(deleted.json.results.find(r => r.id === 'no-such-id').error, '没有找到这个会话的日志目录');
  assert.equal(fs.existsSync(path.join(p.sessions, project, encodeSegment(sessionId))), false, 'log left the sessions tree');
  assert.equal(fs.existsSync(path.join(p.projection, `${encodeSegment(sessionId)}.json`)), false, 'cache moved with the log');
  const trashName = deleted.json.results.find(r => r.ok).trashName;
  const trashed = path.join(trashDir, trashName);
  assert.ok(fs.existsSync(path.join(trashed, 'session', 'session.v4.jsonl.zstd')), 'log payload sits in the trash entry');
  assert.ok(fs.existsSync(path.join(trashed, 'projection.json')), 'projection cache travels too');
  const meta = JSON.parse(fs.readFileSync(path.join(trashed, 'meta.json'), 'utf8'));
  assert.equal(meta.kind, 'session');
  assert.equal(meta.workspaceId, 'ws-1');
  let registry = JSON.parse(fs.readFileSync(p.workspaceFile, 'utf8'));
  assert.deepEqual(registry.tables.workspaces['ws-1'].sessionIds, [], 'registry membership pruned');

  const listed = await call('overview');
  assert.equal(listed.json.trash.length, 1);
  assert.equal(listed.json.trash[0].kind, 'session');
  assert.equal(listed.json.trash[0].title, '要被删掉的会话');
  assert.equal(listed.json.trash[0].id, sessionId);

  /* ------------------------------------------------------------- restore it */

  const restored = await call('restore-session', {
    method: 'POST',
    body: { name: trashName },
    headers: { 'x-dsh-session-manager': '1' },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.ok, true);
  assert.equal(restored.json.registryUpdated, true);
  assert.equal(fs.existsSync(path.join(p.sessions, project, encodeSegment(sessionId), 'session.v4.jsonl.zstd')), true, 'log is back');
  assert.equal(fs.existsSync(path.join(p.projection, `${encodeSegment(sessionId)}.json`)), true, 'cache is back');
  assert.equal(fs.existsSync(trashed), false, 'trash entry consumed by the restore');
  registry = JSON.parse(fs.readFileSync(p.workspaceFile, 'utf8'));
  assert.deepEqual(registry.tables.workspaces['ws-1'].sessionIds, [sessionId], 'workspace membership restored');

  const again = await call('delete-sessions', {
    method: 'POST',
    body: { ids: [sessionId] },
    headers: { 'x-dsh-session-manager': '1' },
  });
  assert.equal(again.json.ok, true);
  const secondName = again.json.results[0].trashName;
  assert.ok(fs.existsSync(path.join(trashDir, secondName)), 'the second deletion also lands in the trash');

  const folderRestore = await call('restore-session', {
    method: 'POST',
    body: { name: 'nope' },
    headers: { 'x-dsh-session-manager': '1' },
  });
  assert.equal(folderRestore.status, 400);
  assert.match(folderRestore.json.error, /回收站里没有/);

  /* ------------------------------------------------------- delete workspace */

  const blocked = await call('delete-workspace', {
    method: 'POST',
    body: { workspaceId: 'ws-1', trash: true },
    headers: { 'x-dsh-session-manager': '1', origin: base },
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.unregistered, true);
  assert.equal(controllerCalls.length, 1, 'the controller is asked exactly once');
  assert.deepEqual(controllerCalls[0], { workspaceId: 'ws-1' });
  assert.ok(blocked.json.trashed?.startsWith(path.resolve(trashDir)), 'the folder moved into the trash');
  assert.equal(fs.existsSync(folder), false, 'original folder location is free');
  assert.equal(fs.existsSync(path.join(blocked.json.trashed, 'a.txt')), true, 'contents survived the move');
  assert.equal(blocked.json.folderError, undefined);

  const unknown = await call('delete-workspace', {
    method: 'POST',
    body: { workspaceId: 'nope' },
    headers: { 'x-dsh-session-manager': '1' },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /不在列表中/);
  assert.equal(controllerCalls.length, 1, 'unknown ids never reach the controller');

  /* --------------------------------------------------------------- trash op */

  await fsp.mkdir(trashDir, { recursive: true });
  const entry = path.join(trashDir, '2026-01-01T00-00-00-old');
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'f.txt'), 'x');
  const purged = await call('purge-trash', {
    method: 'POST',
    body: { name: '2026-01-01T00-00-00-old' },
    headers: { 'x-dsh-session-manager': '1' },
  });
  assert.equal(purged.status, 200);
  assert.equal(purged.json.ok, true);
  assert.equal(fs.existsSync(entry), false);

  const escape = await call('purge-trash', {
    method: 'POST',
    body: { name: '../etc' },
    headers: { 'x-dsh-session-manager': '1' },
  });
  assert.equal(escape.status, 400);
  assert.match(escape.json.error, /无效/);

  const folderEntry = path.basename(blocked.json.trashed);
  const notSession = await call('restore-session', {
    method: 'POST',
    body: { name: folderEntry },
    headers: { 'x-dsh-session-manager': '1' },
  });
  assert.equal(notSession.status, 400);
  assert.match(notSession.json.error, /不是会话条目/);

  const purgeSession = await call('purge-trash', {
    method: 'POST',
    body: { name: secondName },
    headers: { 'x-dsh-session-manager': '1' },
  });
  assert.equal(purgeSession.status, 200);
  assert.equal(fs.existsSync(path.join(trashDir, secondName)), false, 'a session entry can be purged for good');

  console.log('index.js: all checks passed');
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true });
}
