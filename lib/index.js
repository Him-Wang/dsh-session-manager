/**
 * Host half of dsh-session-manager.
 *
 * DSH intentionally has no Session deletion: the JSONL persistence seam says
 * outright that nothing removes session files and offers no deletion API, while
 * the sidebar only archives. This plugin adds the missing maintenance surface:
 *
 *   GET  /dsh-session-manager/overview            inventory of sessions/workspaces/trash
 *   POST /dsh-session-manager/delete-sessions     permanent removal of session logs
 *   POST /dsh-session-manager/delete-workspace    unregister, optionally trash the folder
 *   POST /dsh-session-manager/purge-trash         empty one trash entry for good
 *
 * Workspace bookkeeping goes through the official `workspaceController` so the
 * live registry stays authoritative; only the session-id arrays and the session
 * log directories themselves are touched directly, because no seam exists.
 */
import { isIP } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import {
  forgetSessions, listSessions, listTrash, paths, purgeTrashEntry, readWorkspaces,
  removeSession, resolveHome, trashFolder,
} from './store.js';

const PREFIX = '/dsh-session-manager';
export const name = 'dsh-session-manager';
export const inject = ['webServer', 'workspaceController'];

function sendJson(response, code, body) {
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

/** Raw host routes bypass the RPC gateway's authentication, so stay local. */
function localConnection(request) {
  const address = request.socket?.remoteAddress;
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase();
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  const loopback = normalized === '::1' || (isIP(ipv4) === 4 && ipv4.startsWith('127.'));
  return loopback
    && !Object.hasOwn(request.headers, 'forwarded')
    && !Object.hasOwn(request.headers, 'x-forwarded-for');
}

async function bodyJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
    throw new Error('Expected application/json');
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > 256 * 1024) throw new Error('Request body exceeds 256 KiB');
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return request.headers['sec-fetch-site'] !== 'cross-site';
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.host === request.headers.host;
  } catch {
    return false;
  }
}

function guarded(response, request, method) {
  if (!localConnection(request)) {
    sendJson(response, 403, { ok: false, error: '只允许本机直连 DSH 使用删除功能' });
    return false;
  }
  if (request.method !== method) {
    response.writeHead(405, { allow: method });
    response.end();
    return false;
  }
  if (!sameOrigin(request)) {
    sendJson(response, 403, { ok: false, error: '只允许从 DSH 页面本身调用' });
    return false;
  }
  if (method === 'POST' && request.headers['x-dsh-session-manager'] !== '1') {
    sendJson(response, 403, { ok: false, error: '缺少请求标记' });
    return false;
  }
  return true;
}

/** Paths the running host is standing in; those folders must never move. */
function protectedFolders(p) {
  const guarded = new Set([process.cwd(), p.home]);
  return [...guarded].filter(value => typeof value === 'string' && value !== '');
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const home = resolveHome(config);
  const p = paths(home, config);
  const busyWindowMs = Number.isFinite(config.busyWindowMs) ? config.busyWindowMs : 30000;

  const overview = async () => {
    const { rows, registry } = await listSessions(p);
    const guarded = protectedFolders(p);
    const workspaces = [];
    for (const workspace of registry.workspaces) {
      let exists = false;
      try {
        exists = workspace.path !== '' && fs.statSync(workspace.path).isDirectory();
      } catch {
        exists = false;
      }
      const inUse = workspace.path !== '' && guarded.some(inner => {
        const relative = path.relative(path.resolve(workspace.path), path.resolve(inner));
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });
      // Recent log activity inside this folder is a warning, not a block: the
      // filesystem itself refuses the move while anything holds the directory.
      const activeSessions = workspace.path === '' ? 0 : rows.filter(row => {
        if (row.cwd === '' || row.updatedAt < Date.now() - 10 * 60_000) return false;
        const relative = path.relative(path.resolve(workspace.path), path.resolve(row.cwd));
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      }).length;
      workspaces.push({ ...workspace, exists, inUse, activeSessions });
    }
    const trash = await listTrash(p);
    return {
      ok: true,
      home: p.home,
      sessionsRoot: p.sessions,
      trashDir: p.trash,
      processCwd: process.cwd(),
      totals: {
        sessions: rows.length,
        bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
        trashEntries: trash.length,
        trashBytes: trash.reduce((sum, entry) => sum + entry.bytes, 0),
      },
      sessions: rows.map(({ dir, ...row }) => row),
      workspaces,
      trash,
    };
  };

  const deleteSessions = async body => {
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter(id => typeof id === 'string' && id !== ''))] : [];
    if (ids.length === 0) throw new Error('没有选择要删除的会话');
    const { rows } = await listSessions(p);
    const byId = new Map(rows.map(row => [row.id, row]));
    const results = [];
    const removed = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row === undefined) {
        results.push({ id, ok: false, error: '没有找到这个会话的日志目录' });
        continue;
      }
      try {
        const bytes = await removeSession(p, row, { busyWindowMs });
        removed.push(id);
        results.push({ id, ok: true, bytes });
      } catch (error) {
        results.push({ id, ok: false, error: error.message });
      }
    }
    let registryUpdated = false;
    if (removed.length > 0) {
      try {
        registryUpdated = forgetSessions(p, removed);
      } catch {
        registryUpdated = false;
      }
    }
    return {
      ok: results.every(result => result.ok),
      results,
      removed,
      freed: results.reduce((sum, result) => sum + (result.ok ? result.bytes : 0), 0),
      registryUpdated,
    };
  };

  const deleteWorkspace = async body => {
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    if (workspaceId === '') throw new Error('缺少工作区 id');
    const { workspaces } = readWorkspaces(p.workspaceFile);
    const target = workspaces.find(workspace => workspace.id === workspaceId);
    if (target === undefined) throw new Error('工作区不在列表中');
    let trashed;
    let folderError;
    if (body.trash === true && target.path !== '') {
      try {
        trashed = await trashFolder(p, target.path, { protectedPaths: protectedFolders(p) });
      } catch (error) {
        folderError = error.message;
      }
    }
    // Registration goes through the official controller so the live registry and
    // the durable workspace.json agree; only one call, awaited, so the response
    // reports committed state.
    await ctx.workspaceController.delete({ workspaceId });
    return { ok: true, unregistered: true, trashed, folderError, workspace: target };
  };

  const purgeTrash = async body => {
    await purgeTrashEntry(p, body.name);
    return { ok: true };
  };

  const routes = [
    { path: `${PREFIX}/overview`, method: 'GET', run: async () => overview() },
    { path: `${PREFIX}/delete-sessions`, method: 'POST', run: deleteSessions },
    { path: `${PREFIX}/delete-workspace`, method: 'POST', run: deleteWorkspace },
    { path: `${PREFIX}/purge-trash`, method: 'POST', run: purgeTrash },
  ];

  ctx.inject(['webServer'], host => {
    host.effect(() => {
      const disposers = [];
      try {
        for (const route of routes) {
          disposers.push(host.webServer.register({
            kind: 'exact',
            path: route.path,
            handler: async (request, response) => {
              if (!guarded(response, request, route.method)) return;
              try {
                const body = route.method === 'POST' ? await bodyJson(request) : {};
                sendJson(response, 200, await route.run(body));
              } catch (error) {
                sendJson(response, 400, { ok: false, error: error?.message || String(error) });
              }
            },
          }));
        }
      } catch (error) {
        for (const stop of disposers.reverse()) if (typeof stop === 'function') stop();
        throw error;
      }
      return () => { for (const stop of disposers.reverse()) if (typeof stop === 'function') stop(); };
    }, 'dsh-session-manager: http');
  });
}

export default { name, inject, apply };
