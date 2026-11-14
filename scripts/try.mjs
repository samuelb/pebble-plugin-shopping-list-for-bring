#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Samuel Barabas
//
// Runs src/plugin/index.js against the real Bring! API, with a stand-in for the Pebble runtime,
// so the plugin can be tried without a phone. Storage (including the sign-in token) is kept in a
// private file in your home directory; `signout` deletes it.
//
//   BRING_EMAIL=you@example.com BRING_PASSWORD=... node scripts/try.mjs signin
//   node scripts/try.mjs status
//   node scripts/try.mjs add "2 l milk, eggs and bread"      # like "Try it" on the settings page
//   node scripts/try.mjs action add_items '{"items":[{"name":"Milk","specification":"2 l"}]}'
//   node scripts/try.mjs action read_list '{}'
//   node scripts/try.mjs source shopping item
//   node scripts/try.mjs signout
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, 'src/plugin/index.js'), 'utf8');
// In the user's home rather than the temp directory, which other users may share.
const storeFile = path.join(os.homedir(), '.pebble-bring-plugin-dev.json');
const store = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : { local: {}, secure: {} };
const save = () => fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), { mode: 0o600 });
const area = (name) => ({
  getItem: (k) => (k in store[name] ? store[name][k] : null),
  setItem: (k, v) => { store[name][k] = String(v); save(); },
  removeItem: (k) => { delete store[name][k]; save(); },
});

const handlers = {};
const secure = area('secure');
const context = vm.createContext({
  console: { log: (...a) => process.env.VERBOSE && console.error('[plugin]', ...a), error: (...a) => console.error('[plugin]', ...a) },
  fetch,
  crypto: globalThis.crypto,
  localStorage: area('local'),
  Pebble: {
    secureStorage: {
      getItem: async (k) => secure.getItem(k),
      setItem: async (k, v) => secure.setItem(k, v),
      removeItem: async (k) => secure.removeItem(k),
    },
    permissions: { query: async () => 'granted' },
    registerSourceHandler: (h) => (handlers.source = h),
    registerActionHandler: (h) => (handlers.action = h),
    registerConfigHandler: (h) => (handlers.config = h),
    refreshSources: () => {},
  },
});
vm.runInContext(source, context, { filename: 'src/plugin/index.js' });

const config = (message) => new Promise((resolve) => handlers.config(message, resolve));
const action = (name, args) => new Promise((resolve) => handlers.action({ action: name, args }, {
  ok: (v) => resolve({ ok: true, ...v }),
  error: (code, message) => resolve({ ok: false, code, message }),
}));
const read = (category, item) => new Promise((resolve) => handlers.source({ category, item }, {
  data: resolve,
  error: (code, message) => resolve({ error: { code, message } }),
}));
const print = (value) => console.log(JSON.stringify(value, null, 2));

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'signin': {
    const { BRING_EMAIL: email, BRING_PASSWORD: password } = process.env;
    if (!email || !password) throw new Error('Set BRING_EMAIL and BRING_PASSWORD.');
    print(await config({ type: 'signIn', email, password }));
    break;
  }
  case 'status': print(await config({ type: 'status' })); break;
  case 'default': print(await config({ type: 'setDefaultList', listUuid: rest[0] })); break;
  case 'add': print(await config({ type: 'test', text: rest.join(' ') })); break;
  case 'action': print(await action(rest[0], JSON.parse(rest[1] || '{}'))); break;
  case 'source': print(await read(rest[0], rest[1])); break;
  case 'match': {
    // Dry run: how each name would be stored on the default list. Writes nothing.
    const list = await context.resolveList({});
    const catalog = await context.loadCatalog(list.locale);
    const out = {};
    for (const name of rest) {
      const itemId = await context.itemIdFor(name, list, catalog);
      out[name] = { itemId, shownAs: context.displayName(itemId, catalog), catalog: itemId !== context.capitalize(name.trim()) || context.catalogKey(name, catalog) !== null };
    }
    print({ list: list.name, locale: list.locale, matches: out });
    break;
  }
  case 'remove': {
    // Dev-only cleanup: deletes an item from the default list entirely (not just "recently used").
    const list = await context.resolveList({});
    const items = await context.loadItems(list.uuid);
    const wanted = rest.join(' ').trim().toLowerCase();
    const found = [...items.purchase, ...items.recently].filter((i) => i.itemId.toLowerCase() === wanted);
    for (const item of found) {
      await context.putChanges(list.uuid, [context.change(item.itemId, item.specification || '', item.uuid || null, 'REMOVE')], 'remove the item');
    }
    print({ removed: found.map((i) => i.itemId), list: list.name });
    break;
  }
  case 'signout':
    print(await config({ type: 'signOut' }));
    fs.rmSync(storeFile, { force: true });
    break;
  default:
    console.error('usage: node scripts/try.mjs signin|status|default <listUuid>|add <text>|action <name> <json>|source <category> <item>|signout');
    process.exitCode = 2;
}
