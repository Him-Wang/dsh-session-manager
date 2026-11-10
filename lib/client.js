/* global window */
/**
 * Client half of dsh-session-manager.
 *
 * DSH ships no Session deletion — the sidebar only archives, and the JSONL seam
 * documents that nothing removes the log directories. This browser half puts the
 * missing gesture where the rows already live:
 *
 *  - a `sidebar.workspaces.session.menu.item` row and a
 *    `sidebar.workspaces.session.row.action` hover button that open one shared
 *    confirmation dialog through `shell.overlay`;
 *  - a Settings section with the full inventory: sessions (multi-select delete),
 *    workspaces (unregister, or unregister and move the folder to the DSH trash),
 *    and the trash itself.
 *
 * Everything destructive goes through the plugin's own loopback HTTP routes
 * (see lib/index.js); this half never touches the filesystem.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = null;
    }

    const PREFIX = '/dsh-session-manager/';
    const FLAG = { 'x-dsh-session-manager': '1' };

    async function request(op, body) {
      const response = await fetch(PREFIX + op, {
        cache: 'no-store',
        signal: AbortSignal.timeout(60000),
        ...(body === undefined ? {} : {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...FLAG },
          body: JSON.stringify(body),
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error || `请求失败（HTTP ${response.status}）`);
      return value;
    }

    /* ---------------------------------------------------------------- format */

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    function relativeTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—';
      const seconds = Math.round((Date.now() - ms) / 1000);
      if (seconds < 60) return '刚刚';
      if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
      if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
      return new Date(ms).toLocaleDateString();
    }

    /* ------------------------------------------------- shared delete pending */

    /** One confirmation at a time, shared by the row menu, hover button and panel. */
    const pendingStore = { value: null, listeners: new Set() };

    function setPending(next) {
      pendingStore.value = next;
      for (const listener of [...pendingStore.listeners]) listener();
    }

    function usePending() {
      const [, force] = useState(0);
      useEffect(() => {
        const listener = () => force(value => value + 1);
        pendingStore.listeners.add(listener);
        return () => { pendingStore.listeners.delete(listener); };
      }, []);
      return pendingStore.value;
    }

    /* ------------------------------------------------------------- styles */

    const STYLES = `
      .dsh-sm{max-width:920px;font-size:15px;line-height:1.6;color:inherit;overflow-wrap:anywhere}
      .dsh-sm h2{font-size:22px;margin:0 0 6px}
      .dsh-sm h3{font-size:17px;margin:26px 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dsh-sm p{margin:6px 0}
      .dsh-sm .muted{opacity:.72;font-size:13px}
      .dsh-sm .bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0}
      .dsh-sm button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;padding:6px 12px;min-height:36px;cursor:pointer}
      .dsh-sm button:hover:not(:disabled){background:var(--color-background-secondary,rgba(128,128,128,.14))}
      .dsh-sm button:disabled{opacity:.45;cursor:default}
      .dsh-sm button.primary{font-weight:600;border-width:2px}
      .dsh-sm button.danger{color:var(--color-danger,#d0453b);border-color:currentColor}
      .dsh-sm .scroll{overflow-x:auto;border:1px solid rgba(128,128,128,.28);border-radius:8px}
      .dsh-sm table{width:100%;border-collapse:collapse;font-size:14px;text-align:left}
      .dsh-sm th,.dsh-sm td{padding:8px 10px;border-bottom:1px solid rgba(128,128,128,.22);vertical-align:top}
      .dsh-sm thead th{font-weight:600;background:rgba(128,128,128,.08)}
      .dsh-sm tbody tr:last-child td{border-bottom:none}
      .dsh-sm td.title{max-width:360px}
      .dsh-sm td.title span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-sm td.num{white-space:nowrap;font-variant-numeric:tabular-nums}
      .dsh-sm code{font-size:12.5px;background:rgba(128,128,128,.14);padding:1px 5px;border-radius:4px}
      .dsh-sm .tag{display:inline-block;font-size:12px;padding:0 6px;border-radius:10px;border:1px solid rgba(128,128,128,.5);margin-left:6px;opacity:.85}
      .dsh-sm .notice{border:1px solid currentColor;border-radius:6px;padding:10px 12px;margin:12px 0}
      .dsh-sm .notice.alert{border-color:var(--color-danger,#d0453b);color:var(--color-danger,#d0453b)}
      .dsh-sm .confirm{border:2px solid var(--color-danger,#d0453b);border-radius:8px;padding:12px 14px;margin:12px 0}
      .dsh-sm .confirm ul{margin:8px 0;padding-left:20px;max-height:180px;overflow:auto}
      .dsh-sm .empty{padding:14px;opacity:.72}
      .dsh-sm .tabs{display:flex;gap:6px;margin:14px 0 6px}
      .dsh-sm .tabs button{border-radius:999px}
      .dsh-sm .tabs button[aria-pressed="true"]{font-weight:600;background:rgba(128,128,128,.18)}
    `;

    /* -------------------------------------------------------- confirm dialog */

    function DeleteSessionDialog() {
      const pending = usePending();
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [done, setDone] = useState(null);
      const alive = useRef(true);
      useEffect(() => () => { alive.current = false; }, []);

      const close = useCallback(() => {
        if (busy) return;
        setPending(null);
        setDone(null);
        setError(null);
      }, [busy]);

      const confirm = useCallback(async () => {
        if (pending === null || busy) return;
        setBusy(true);
        setError(null);
        try {
          const result = await request('delete-sessions', { ids: pending.ids });
          const failed = (result.results ?? []).filter(row => !row.ok);
          if (failed.length > 0) throw new Error(failed.map(row => row.error).join('；'));
          if (alive.current) setDone({ count: pending.ids.length, freed: result.freed });
        } catch (reason) {
          if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [pending, busy]);

      if (pending === null) return null;

      const Modal = primitives?.Modal;
      const Button = primitives?.Button;
      const footer = done !== null
        ? (Button === undefined ? null : h(Button, { variant: 'outline', onClick: () => window.location.reload() }, '刷新页面以更新侧栏'))
        : (Button === undefined ? null : h(React.Fragment, null,
          h(Button, { variant: 'outline', disabled: busy, onClick: close }, '取消'),
          h(Button, { variant: 'outline', disabled: busy, onClick: confirm }, '彻底删除'),
        ));

      const body = [
        h('p', { key: 'titles' }, `会话：${pending.titles.join('、')}`),
        pending.bytes === undefined ? null : h('p', { key: 'size', className: 'muted' }, `占用约 ${formatBytes(pending.bytes)}`),
        done !== null
          ? h('p', { key: 'done', role: 'status' }, `已彻底删除 ${done.count} 个会话，释放 ${formatBytes(done.freed)}。侧栏在刷新页面后同步。`)
          : h('p', { key: 'warning' }, '会话日志、标题和工作区记录都会被删除，无法撤销。正在使用的会话请先切换走。'),
        busy && done === null ? h('p', { key: 'busy', className: 'muted' }, '正在删除…') : null,
        error !== null ? h('p', { key: 'error', role: 'alert', style: { color: 'var(--color-danger,#d0453b)' } }, error) : null,
      ].filter(Boolean);

      // Fall back to the platform dialog only when the primitive is unreachable.
      if (Modal === undefined) {
        return h('div', { className: 'dsh-sm' }, h('style', null, STYLES),
          h('section', { className: 'confirm' },
            h('h3', null, '彻底删除会话？'), ...body,
            h('div', { className: 'bar' },
              h('button', { type: 'button', onClick: close, disabled: busy }, '取消'),
              h('button', { type: 'button', className: 'danger', onClick: confirm, disabled: busy }, '彻底删除'))));
      }

      return h(Modal, {
        open: true,
        onClose: close,
        closeLabel: '关闭',
        title: '彻底删除会话？',
        description: `将永久删除 ${pending.ids.length} 个会话的日志与标题记录，无法撤销。`,
        footer,
        children: body,
      });
    }

    /* ------------------------------------------------------------ settings */

    function ManagerPanel() {
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const [failure, setFailure] = useState(false);
      const [selected, setSelected] = useState(() => new Set());
      const [confirm, setConfirm] = useState(null);
      const [tab, setTab] = useState('sessions');
      const alive = useRef(true);
      const running = useRef(false);

      const load = useCallback(async () => {
        const result = await request('overview');
        if (!alive.current) return;
        setState(result);
        setSelected(current => {
          const live = new Set(result.sessions.map(row => row.id));
          const next = new Set([...current].filter(id => live.has(id)));
          return next.size === current.size ? current : next;
        });
      }, []);

      const action = useCallback(async work => {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        setNotice('');
        setFailure(false);
        try {
          await work();
        } catch (error) {
          if (alive.current) {
            setNotice(error instanceof Error ? error.message : String(error));
            setFailure(true);
          }
        } finally {
          running.current = false;
          if (alive.current) setBusy(false);
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        action(async () => {
          try {
            await load();
          } catch (error) {
            setNotice(`读取清单失败：${error.message}`);
            setFailure(true);
          }
        });
        return () => { alive.current = false; };
      }, [action, load]);

      const sessions = state?.sessions ?? [];
      const workspaces = state?.workspaces ?? [];
      const trash = state?.trash ?? [];
      const allSelected = sessions.length > 0 && selected.size === sessions.length;

      const toggle = useCallback(id => {
        setSelected(current => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, []);

      const deleteSessions = useCallback(ids => action(async () => {
        const result = await request('delete-sessions', { ids });
        const failed = (result.results ?? []).filter(row => !row.ok);
        await load();
        setConfirm(null);
        if (failed.length > 0) {
          setNotice(`${result.removed.length} 个会话已删除，${failed.length} 个失败：${failed.map(row => row.error).join('；')}`);
          setFailure(true);
        } else {
          setNotice(`已彻底删除 ${result.removed.length} 个会话，释放 ${formatBytes(result.freed)}。刷新页面后侧栏同步。`);
        }
      }), [action, load]);

      const removeWorkspace = useCallback((workspace, withTrash) => action(async () => {
        const result = await request('delete-workspace', { workspaceId: workspace.id, trash: withTrash });
        await load();
        setConfirm(null);
        if (result.folderError) {
          setNotice(`已从工作区列表移除，但文件夹没有移动：${result.folderError}`);
          setFailure(true);
        } else if (result.trashed) {
          setNotice(`已移除并把文件夹移到回收站：${result.trashed}`);
        } else {
          setNotice('已从工作区列表移除；文件夹与会话记录都还在，其会话显示在“未分组”下。');
        }
      }), [action, load]);

      const purgeTrash = useCallback(name => action(async () => {
        await request('purge-trash', { name });
        await load();
        setConfirm(null);
        setNotice('回收站条目已彻底删除。');
      }), [action, load]);

      const rows = sessions.map(row => h('tr', { key: row.id },
        h('td', null, h('input', {
          type: 'checkbox',
          checked: selected.has(row.id),
          disabled: busy,
          'aria-label': `选择 ${row.title}`,
          onChange: () => toggle(row.id),
        })),
        h('td', { className: 'title', title: row.title }, h('span', null, row.title),
          row.pinned ? h('span', { className: 'tag' }, '置顶') : null,
          row.archived ? h('span', { className: 'tag' }, '已归档') : null),
        h('td', { className: 'num muted' }, relativeTime(row.updatedAt)),
        h('td', { className: 'num' }, formatBytes(row.bytes)),
        h('td', { className: 'muted' }, workspaces.find(workspace => workspace.id === row.workspaceId)?.title ?? '未分组'),
        h('td', null, h('button', {
          type: 'button',
          className: 'danger',
          disabled: busy,
          onClick: () => setConfirm({ kind: 'sessions', ids: [row.id], titles: [row.title], bytes: row.bytes }),
        }, '删除')),
      ));

      const sessionTab = h(React.Fragment, null,
        h('div', { className: 'bar' },
          h('button', {
            type: 'button',
            disabled: busy || sessions.length === 0,
            onClick: () => setSelected(allSelected ? new Set() : new Set(sessions.map(row => row.id))),
          }, allSelected ? '取消全选' : '全选'),
          h('button', {
            type: 'button',
            className: 'danger',
            disabled: busy || selected.size === 0,
            onClick: () => {
              const chosen = sessions.filter(row => selected.has(row.id));
              setConfirm({
                kind: 'sessions',
                ids: chosen.map(row => row.id),
                titles: chosen.slice(0, 5).map(row => row.title).concat(chosen.length > 5 ? [`… 等 ${chosen.length} 个`] : []),
                bytes: chosen.reduce((sum, row) => sum + row.bytes, 0),
              });
            },
          }, `删除选中（${selected.size}）`),
          h('span', { className: 'muted' }, `共 ${sessions.length} 个会话 · ${formatBytes(state?.totals?.bytes ?? 0)}`)),
        sessions.length === 0
          ? h('p', { className: 'empty' }, '没有找到会话日志。')
          : h('div', { className: 'scroll' }, h('table', null,
            h('thead', null, h('tr', null,
              h('th', { scope: 'col' }, h('input', {
                type: 'checkbox',
                checked: allSelected,
                disabled: busy,
                'aria-label': '全选会话',
                onChange: () => setSelected(allSelected ? new Set() : new Set(sessions.map(row => row.id))),
              })),
              h('th', { scope: 'col' }, '标题'),
              h('th', { scope: 'col' }, '最近活动'),
              h('th', { scope: 'col' }, '占用'),
              h('th', { scope: 'col' }, '工作区'),
              h('th', { scope: 'col' }, ''))),
            h('tbody', null, rows))));

      const workspaceTab = workspaces.length === 0
        ? h('p', { className: 'empty' }, '没有注册的工作区。')
        : h('div', { className: 'scroll' }, h('table', null,
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, '工作区'),
            h('th', { scope: 'col' }, '文件夹'),
            h('th', { scope: 'col' }, '会话'),
            h('th', { scope: 'col' }, '操作'))),
          h('tbody', null, workspaces.map(workspace => h('tr', { key: workspace.id },
            h('td', null, workspace.title, workspace.isDefault ? h('span', { className: 'tag' }, '默认') : null,
              workspace.exists ? null : h('span', { className: 'tag' }, '文件夹不存在')),
            h('td', null, h('code', { title: workspace.path }, workspace.path || '（无路径）')),
            h('td', { className: 'num muted' }, String(workspace.sessionIds.length)),
            h('td', null, h('div', { className: 'bar', style: { margin: 0 } },
              h('button', {
                type: 'button',
                disabled: busy,
                onClick: () => setConfirm({ kind: 'workspace', workspace, trash: false }),
              }, '仅从列表移除'),
              h('button', {
                type: 'button',
                className: 'danger',
                disabled: busy || !workspace.exists || workspace.inUse,
                title: workspace.inUse ? 'DSH 正在使用这个文件夹，无法移动' : workspace.exists ? '把文件夹移到 DSH 回收站，不会直接删除' : '文件夹不存在',
                onClick: () => setConfirm({ kind: 'workspace', workspace, trash: true }),
              }, '移除并移入回收站'))))))));

      const trashTab = trash.length === 0
        ? h('p', { className: 'empty' }, '回收站是空的。移入回收站的文件夹可以从这里彻底删除，或到磁盘上手动恢复。')
        : h(React.Fragment, null,
          h('p', { className: 'muted' }, `回收站：${state?.trashDir}`),
          h('div', { className: 'scroll' }, h('table', null,
            h('thead', null, h('tr', null,
              h('th', { scope: 'col' }, '条目'),
              h('th', { scope: 'col' }, '移入时间'),
              h('th', { scope: 'col' }, '占用'),
              h('th', { scope: 'col' }, ''))),
            h('tbody', null, trash.map(entry => h('tr', { key: entry.name },
              h('td', null, h('code', null, entry.name)),
              h('td', { className: 'num muted' }, relativeTime(entry.movedAt)),
              h('td', { className: 'num' }, formatBytes(entry.bytes)),
              h('td', null, h('button', {
                type: 'button',
                className: 'danger',
                disabled: busy,
                onClick: () => setConfirm({ kind: 'trash', name: entry.name, bytes: entry.bytes }),
              }, '彻底删除'))))))));

      const confirmBlock = (() => {
        if (confirm === null) return null;
        if (confirm.kind === 'sessions') {
          return h('div', { className: 'confirm', role: 'group', 'aria-label': '确认删除会话' },
            h('h3', null, `彻底删除 ${confirm.ids.length} 个会话？`),
            h('ul', null, confirm.titles.map((title, index) => h('li', { key: `${index}-${title}` }, title))),
            h('p', null, `将删除会话日志、标题缓存与工作区记录，释放约 ${formatBytes(confirm.bytes ?? 0)}。无法撤销。`),
            h('div', { className: 'bar' },
              h('button', { type: 'button', disabled: busy, onClick: () => setConfirm(null) }, '取消'),
              h('button', { type: 'button', className: 'danger primary', disabled: busy, onClick: () => deleteSessions(confirm.ids) }, '确认永久删除')));
        }
        if (confirm.kind === 'workspace') {
          const { workspace, trash: withTrash } = confirm;
          return h('div', { className: 'confirm', role: 'group', 'aria-label': '确认移除工作区' },
            h('h3', null, withTrash ? '移除工作区并把文件夹移入回收站？' : '从工作区列表移除？'),
            h('p', null, h('code', null, workspace.path || workspace.title)),
            withTrash && (workspace.activeSessions ?? 0) > 0
              ? h('p', { className: 'muted' }, `${workspace.activeSessions} 个会话最近 10 分钟在这个文件夹里活动；如果移动失败，请先退出这些会话再试。`)
              : null,
            h('p', null, withTrash
              ? '文件夹会被移动到 DSH 回收站（不是直接删除），可以在「回收站」页签里彻底清除或手动恢复。该工作区的会话日志默认保留。'
              : '只移除工作区分组；文件夹与会话日志都保留，会话退回“未分组”。'),
            h('div', { className: 'bar' },
              h('button', { type: 'button', disabled: busy, onClick: () => setConfirm(null) }, '取消'),
              h('button', {
                type: 'button',
                className: withTrash ? 'danger primary' : 'primary',
                disabled: busy,
                onClick: () => removeWorkspace(workspace, withTrash),
              }, withTrash ? '确认移除并移动' : '确认移除')));
        }
        return h('div', { className: 'confirm', role: 'group', 'aria-label': '确认清空回收站条目' },
          h('h3', null, '彻底删除这个回收站条目？'),
          h('p', null, h('code', null, confirm.name), ` · ${formatBytes(confirm.bytes ?? 0)}`),
          h('p', null, '会从磁盘上删除它，无法恢复。'),
          h('div', { className: 'bar' },
            h('button', { type: 'button', disabled: busy, onClick: () => setConfirm(null) }, '取消'),
            h('button', { type: 'button', className: 'danger primary', disabled: busy, onClick: () => purgeTrash(confirm.name) }, '确认删除')));
      })();

      return h('section', { className: 'dsh-sm', 'aria-label': '会话与工作区清理', 'aria-busy': busy },
        h('style', null, STYLES),
        h('h2', null, '会话与工作区清理'),
        h('p', { className: 'muted' }, 'DSH 默认只做归档、不删会话日志，工作区删除也保留文件夹。这里可以真正删掉它们。'),
        h('div', { className: 'bar' },
          h('button', { type: 'button', disabled: busy, onClick: () => action(load) }, busy ? '读取中…' : '刷新清单'),
          h('span', { className: 'muted' }, state === null
            ? '正在读取…'
            : `${sessions.length} 个会话 · ${formatBytes(state.totals.bytes)} · 回收站 ${state.totals.trashEntries} 项 ${formatBytes(state.totals.trashBytes)}`)),
        notice === '' ? null : h('p', { className: failure ? 'notice alert' : 'notice', role: failure ? 'alert' : 'status' }, notice),
        h('div', { className: 'tabs' }, ['sessions', 'workspaces', 'trash'].map(key => h('button', {
          key,
          type: 'button',
          'aria-pressed': tab === key ? 'true' : 'false',
          onClick: () => { setTab(key); setConfirm(null); },
        }, key === 'sessions' ? '会话' : key === 'workspaces' ? '工作区' : '回收站'))),
        confirmBlock,
        tab === 'sessions' ? sessionTab : tab === 'workspaces' ? workspaceTab : trashTab,
        state === null ? null : h('details', null,
          h('summary', null, '路径与说明'),
          h('p', null, 'DSH 数据目录：', h('code', null, state.home)),
          h('p', null, '会话日志：', h('code', null, state.sessionsRoot)),
          h('p', null, '回收站：', h('code', null, state.trashDir)),
          h('p', null, '当前进程目录：', h('code', null, state.processCwd))));
    }

    /* ---------------------------------------------------------------- entries */

    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
      const closeMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : () => {};
      const MenuItemButton = primitives?.MenuItemButton;
      const Icon = primitives?.IconTrashOutlineRegular;
      const onSelect = () => {
        closeMenu(false);
        setPending({ ids: [sessionId], titles: [displayTitle ?? sessionId] });
      };
      if (MenuItemButton === undefined) {
        return h('button', { type: 'button', role: 'menuitem', onClick: onSelect }, '彻底删除会话…');
      }
      return h(MenuItemButton, {
        separatorBefore: true,
        icon: Icon === undefined ? undefined : h(Icon, { size: 14 }),
        onSelect,
      }, '彻底删除会话…');
    }

    function DeleteSessionRowButton({ sessionId, displayTitle }) {
      const Tooltip = primitives?.Tooltip;
      const Icon = primitives?.IconTrashOutlineRegular;
      const onClick = () => setPending({ ids: [sessionId], titles: [displayTitle ?? sessionId] });
      const button = h('button', {
        type: 'button',
        className: 'dsh-sm-row-delete',
        'aria-label': '彻底删除会话',
        title: '彻底删除会话',
        onClick,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, padding: 0, border: 'none', borderRadius: 4,
          background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.75,
        },
      }, Icon === undefined ? h('span', { 'aria-hidden': true }, '×') : h(Icon, { size: 14 }));
      if (Tooltip === undefined) return button;
      return h(Tooltip, { label: '彻底删除会话', side: 'bottom', align: 'end', delayMs: 500, portal: true }, button);
    }

    return {
      name: 'dsh-session-manager',
      inject: ['slots'],
      apply: ctx => {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-session-manager.delete-dialog',
        }, DeleteSessionDialog));

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-session-manager.delete-session',
          order: 550,
        }, DeleteSessionMenuItem));

        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'dsh-session-manager.delete-session',
          order: 300,
        }, DeleteSessionRowButton));

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-session-manager',
          order: 45,
          label: () => '会话与工作区清理',
        }, () => h(ManagerPanel)));
      },
    };
  },
});
