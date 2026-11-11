/**
 * Load-time checks for lib/client.js: the browser half must survive evaluation
 * with no DOM, ask for each slot declaration first, and build its elements.
 * Rendering is out of scope — components are only constructed, never mounted.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientFile = path.join(path.dirname(here), 'lib', 'client.js');

const recorded = [];
globalThis.window = { __ModuleLoader__: { load: entry => { recorded.push(entry); } } };

await import(pathToFileURL(clientFile).href);
assert.equal(recorded.length, 1, 'the file registers exactly one bundle');
assert.equal(recorded[0].id, 'dsh-session-manager', 'bundle id matches the package');

function component(tag) {
  return props => ({ tag, props });
}

function requireStub(name) {
  if (name === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      Fragment: Symbol('fragment'),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useCallback: fn => fn,
      useMemo: fn => fn(),
      useRef: initial => ({ current: initial }),
    };
  }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      MenuItemButton: component('MenuItemButton'),
      Modal: component('Modal'),
      Button: component('Button'),
      Tooltip: component('Tooltip'),
      IconTrashOutlineRegular: component('IconTrashOutlineRegular'),
    };
  }
  throw new Error(`unexpected require: ${name}`);
}

const clientModule = recorded[0].factory(requireStub);
assert.equal(clientModule.name, 'dsh-session-manager');
assert.deepEqual(clientModule.inject, ['slots'], 'only the slots service is required');

const order = [];
const contributed = new Map();

clientModule.apply({
  slots: {
    inject(slotName, contribute) {
      order.push(slotName);
      contribute();
    },
    register(definition, render) {
      assert.equal(typeof render, 'function', `${definition.name} carries a component`);
      assert.equal(definition.name, definition.name.trim());
      contributed.set(definition.name, { definition, render });
      return () => {};
    },
  },
});

assert.deepEqual(order, [
  'shell.overlay',
  'sidebar.workspaces.session.menu.item',
  'sidebar.workspaces.session.row.action',
  'settings.section',
], 'each entry waits for its slot declaration');
assert.equal(contributed.size, 4, 'four entries registered');

const menu = contributed.get('sidebar.workspaces.session.menu.item');
assert.equal(menu.definition.order, 550, 'sits after the shipped session-id row (450)');
assert.equal(menu.definition.id, 'dsh-session-manager.delete-session');

const rowAction = contributed.get('sidebar.workspaces.session.row.action');
assert.equal(rowAction.definition.order, 300);

const overlay = contributed.get('shell.overlay');
assert.equal(overlay.render({}), null, 'the overlay renders nothing while no deletion is pending');

const panel = contributed.get('settings.section');
assert.equal(typeof panel.definition.label, 'function');
assert.match(panel.definition.label(), /清理/);

const menuElement = menu.render({
  sessionId: 'session-1',
  displayTitle: '示例会话',
  useMenuOpenState: () => [false, () => {}],
});
assert.ok(menuElement && menuElement.props !== undefined, 'menu item builds an element');
assert.match(JSON.stringify(menuElement), /移到回收站/);

const buttonElement = rowAction.render({ sessionId: 'session-1', displayTitle: '示例会话' });
assert.ok(buttonElement, 'hover button builds an element');
assert.match(JSON.stringify(buttonElement), /移到回收站/);

const panelWrapper = panel.render({});
assert.ok(panelWrapper, 'settings panel wrapper builds an element');
const panelElement = panelWrapper.type({}, {});
assert.ok(panelElement, 'settings panel body builds an element');
assert.match(JSON.stringify(panelElement), /会话与工作区清理/);
assert.match(JSON.stringify(panelElement), /回收站/);

console.log('client.js: all checks passed');
