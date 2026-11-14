// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Samuel Barabas
//
// Runs the plugin script in a VM with a fake Pebble runtime and a fake Bring! server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');
const API = 'https://api.getbring.com/rest/';
const LIST = 'list-home';
const PARTY = 'list-party';
const USER = 'user-1';

function fakeBring(options = {}) {
  const server = {
    requests: [],
    token: 'token-1',
    refreshToken: 'refresh-1',
    refreshStatus: 200,
    lists: { [LIST]: { name: 'Zuhause', purchase: [], recently: [] }, [PARTY]: { name: 'Party', purchase: [], recently: [] } },
    listLanguages: { [LIST]: 'en-US', [PARTY]: 'de-DE' },
    catalogs: {
      'en-US': { Milch: 'Milk', Eier: 'Eggs', Brot: 'Bread', Gipfeli: 'Croissant' },
      'de-DE': { Milch: 'Milch', Eier: 'Eier', Rüebli: 'Karotten' },
    },
    ...options,
  };
  const reply = (status, body) => ({
    status,
    text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  });
  server.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    server.requests.push({ url, method, headers, body: init.body });
    if (url.startsWith('https://web.getbring.com/locale/articles.')) {
      const locale = url.slice('https://web.getbring.com/locale/articles.'.length, -'.json'.length);
      return server.catalogs[locale] ? reply(200, server.catalogs[locale]) : reply(404, 'nope');
    }
    if (!url.startsWith(API)) return reply(404);
    const route = url.slice(API.length);
    if (route === 'v2/bringauth' && method === 'POST') {
      const form = new URLSearchParams(init.body);
      if (form.get('email') !== 'me@example.com' || form.get('password') !== 'secret') return reply(401, { message: 'bad' });
      return reply(200, {
        uuid: USER, publicUuid: 'public-1', bringListUUID: LIST, access_token: server.token,
        refresh_token: server.refreshToken, token_type: 'Bearer', expires_in: 604799, name: 'Sam', email: 'me@example.com',
      });
    }
    if (route === 'v2/bringauth/token' && method === 'POST') {
      if (server.refreshStatus !== 200) return reply(server.refreshStatus, { message: 'no' });
      const form = new URLSearchParams(init.body);
      assert.strictEqual(form.get('grant_type'), 'refresh_token');
      assert.strictEqual(form.get('refresh_token'), server.refreshToken);
      server.token = 'token-' + (Number(server.token.split('-')[1]) + 1);
      return reply(200, { access_token: server.token, token_type: 'Bearer', expires_in: 604799 });
    }
    if (headers.Authorization !== 'Bearer ' + server.token) return reply(401, { message: 'expired' });
    assert.strictEqual(headers['X-BRING-API-KEY'], 'cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp');
    assert.strictEqual(headers['X-BRING-USER-UUID'], USER);
    if (route === `v2/bringusers/${USER}`) return reply(200, { userUuid: USER, userLocale: { language: 'de', country: 'DE' } });
    if (route === `bringusersettings/${USER}`) {
      return reply(200, {
        usersettings: [{ key: 'defaultListUUID', value: LIST }],
        userlistsettings: Object.entries(server.listLanguages).map(([listUuid, value]) => ({
          listUuid, usersettings: [{ key: 'listArticleLanguage', value }],
        })),
      });
    }
    if (route === `bringusers/${USER}/lists`) {
      return reply(200, { lists: Object.entries(server.lists).map(([listUuid, l]) => ({ listUuid, name: l.name, theme: 'ch.publisheria.bring.theme.home' })) });
    }
    let m = /^v2\/bringlists\/([^/]+)$/.exec(route);
    if (m && method === 'GET') {
      const l = server.lists[m[1]];
      return l ? reply(200, { uuid: m[1], status: 'REGISTERED', items: { purchase: l.purchase, recently: l.recently } }) : reply(404);
    }
    m = /^v2\/bringlists\/([^/]+)\/items$/.exec(route);
    if (m && method === 'PUT') {
      const l = server.lists[m[1]];
      const body = JSON.parse(init.body);
      for (const c of body.changes) {
        // Bring! keeps an entry per uuid, so one product can be on a list in several variants.
        const same = (i) => (c.uuid ? i.uuid === c.uuid : i.itemId === c.itemId);
        l.purchase = l.purchase.filter((i) => !same(i));
        l.recently = l.recently.filter((i) => !same(i));
        const item = { uuid: c.uuid, itemId: c.itemId, specification: c.spec, attributes: [] };
        if (c.operation === 'TO_PURCHASE') l.purchase.push(item);
        if (c.operation === 'TO_RECENTLY') l.recently.push(item);
      }
      return reply(200);
    }
    return reply(404, 'no route ' + method + ' ' + route);
  };
  return server;
}

function load(server, stored = {}) {
  const secure = new Map(Object.entries(stored.secure || {}));
  const local = new Map(Object.entries(stored.local || {}));
  const handlers = {};
  const refreshed = [];
  const context = {
    console: { log() {}, error() {} },
    URLSearchParams,
    localStorage: {
      getItem: (k) => (local.has(k) ? local.get(k) : null),
      setItem: (k, v) => local.set(k, String(v)),
      removeItem: (k) => local.delete(k),
    },
    fetch: (...args) => server.fetch(...args),
    Pebble: {
      secureStorage: {
        getItem: async (k) => (secure.has(k) ? secure.get(k) : null),
        setItem: async (k, v) => secure.set(k, v),
        removeItem: async (k) => secure.delete(k),
      },
      permissions: { query: async () => 'granted' },
      registerSourceHandler: (h) => (handlers.source = h),
      registerActionHandler: (h) => (handlers.action = h),
      registerConfigHandler: (h) => (handlers.config = h),
      refreshSources: (s) => refreshed.push(s),
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  // Values from the VM's realm don't deepStrictEqual this realm's arrays; compare plain copies.
  const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const config = (message) => new Promise((resolve) => handlers.config(message, (v) => resolve(plain(v))));
  const action = async (name, args) => {
    const out = {};
    await handlers.action({ action: name, args }, {
      ok: (v) => (out.ok = plain(v)),
      error: (code, message) => (out.error = { code, message }),
    });
    return out;
  };
  const source = async (category, item) => {
    const out = {};
    await handlers.source({ category, item }, {
      data: (v) => (out.data = plain(v)),
      error: (code, message) => (out.error = { code, message }),
    });
    return out;
  };
  return { context, handlers, secure, local, refreshed, config, action, source };
}

async function signedIn(server = fakeBring()) {
  const plugin = load(server);
  const result = await plugin.config({ type: 'signIn', email: 'me@example.com', password: 'secret' });
  assert.strictEqual(result.signedIn, true, JSON.stringify(result));
  return { server, plugin };
}

const lastPut = (server) => JSON.parse(server.requests.filter((r) => r.method === 'PUT').pop().body);

// The sign-in's tokens. Each sign-in keeps them under a key of its own (bring.auth.v1[.<session>]).
const authKeyOf = (plugin) => [...plugin.secure.keys()].find((k) => k.startsWith('bring.auth.v1'));
const storedAuth = (plugin) => JSON.parse(plugin.secure.get(authKeyOf(plugin)));
const expireToken = (plugin) => plugin.secure.set(authKeyOf(plugin), JSON.stringify({ ...storedAuth(plugin), expiresAt: 1 }));

test('signing in keeps the tokens but never the password, and lists the lists', async () => {
  const { plugin } = await signedIn();
  const stored = [...plugin.secure.values(), ...plugin.local.values()].join('\n');
  assert.ok(!stored.includes('secret'));
  assert.ok(storedAuth(plugin).refreshToken === 'refresh-1');
  const status = await plugin.config({ type: 'status' });
  assert.deepStrictEqual(status.lists.map((l) => l.name), ['Zuhause', 'Party']);
  assert.strictEqual(status.defaultList, LIST);
  assert.strictEqual(status.name, 'Sam');
});

test('a wrong password is reported, not stored', async () => {
  const plugin = load(fakeBring());
  const result = await plugin.config({ type: 'signIn', email: 'me@example.com', password: 'nope' });
  assert.strictEqual(result.signedIn, false);
  assert.match(result.error, /didn't accept/);
  assert.strictEqual(plugin.secure.size, 0);
});

test('add_items saves catalog items by their catalog key, others as said, to the default list', async () => {
  const { server, plugin } = await signedIn();
  const out = await plugin.action('add_items', { items: [{ name: 'milk', specification: '2 l' }, { name: 'oat flakes' }] });
  assert.ok(out.ok, JSON.stringify(out));
  assert.strictEqual(out.ok.text, 'Added Milk (2 l) and Oat flakes to Zuhause.');
  assert.deepStrictEqual(out.ok.refreshed, ['shopping/list', 'shopping/item']);
  const body = lastPut(server);
  assert.deepStrictEqual(body.changes.map((c) => [c.itemId, c.spec, c.operation]), [['Milch', '2 l', 'TO_PURCHASE'], ['Oat flakes', '', 'TO_PURCHASE']]);
  assert.ok(body.changes.every((c) => /^[0-9a-f-]{36}$/.test(c.uuid)));
});

test('a list can be picked by name or instanceId, and uses that list\'s language', async () => {
  const { server, plugin } = await signedIn();
  let out = await plugin.action('add_items', { items: [{ name: 'Karotten' }], list: 'party' });
  assert.strictEqual(out.ok.text, 'Added Karotten to Party.');
  assert.strictEqual(lastPut(server).changes[0].itemId, 'Rüebli');
  assert.ok(server.requests.some((r) => r.url === API + `v2/bringlists/${PARTY}/items`));
  out = await plugin.action('add_items', { items: [{ name: 'Eier' }], instanceId: PARTY });
  assert.strictEqual(out.ok.text, 'Added Eier to Party.');
  out = await plugin.action('add_items', { items: [{ name: 'Brot' }], list: 'the party list' });
  assert.strictEqual(out.ok.text, 'Added Brot to Party.');
  out = await plugin.action('add_items', { items: [{ name: 'Eier' }], list: 'Garage' });
  assert.strictEqual(out.error.code, 'INVALID_ARGS');
  assert.match(out.error.message, /Zuhause, Party/);
});

test('a generic list name like "shopping list" means the default list', async () => {
  const { plugin } = await signedIn();
  for (const list of ['shopping list', 'Einkaufsliste', 'my grocery list', 'Bring']) {
    const out = await plugin.action('add_items', { items: [{ name: 'Milk' }], list });
    assert.ok(out.ok, list + ': ' + JSON.stringify(out));
    assert.match(out.ok.text, /Zuhause/);
  }
});

test('items given as plain strings have their amounts split off', async () => {
  const { server, plugin } = await signedIn();
  const out = await plugin.action('add_items', { items: ['2 l milk', 'bread'] });
  assert.strictEqual(out.ok.text, 'Added Milk (2 l) and Bread to Zuhause.');
  assert.deepStrictEqual(lastPut(server).changes.map((c) => [c.itemId, c.spec]), [['Milch', '2 l'], ['Brot', '']]);
});

test('an item already on the list is left alone, and one in "recently" moves back with its uuid', async () => {
  const server = fakeBring();
  server.lists[LIST].purchase = [{ uuid: 'u-milk', itemId: 'Milch', specification: '' }];
  server.lists[LIST].recently = [{ uuid: 'u-bread', itemId: 'Brot', specification: 'dark' }];
  const { plugin } = await signedIn(server);
  let out = await plugin.action('add_items', { items: [{ name: 'Milk' }] });
  assert.strictEqual(out.ok.text, 'Milk is already on Zuhause.');
  assert.ok(!server.requests.some((r) => r.method === 'PUT'));
  out = await plugin.action('add_items', { items: [{ name: 'bread' }, { name: 'milk', specification: 'oat' }] });
  assert.strictEqual(out.ok.text, 'Added Bread (dark) and Milk (oat) (updated) to Zuhause.');
  assert.deepStrictEqual(lastPut(server).changes.map((c) => [c.itemId, c.spec, c.uuid]), [['Brot', 'dark', 'u-bread'], ['Milch', 'oat', 'u-milk']]);
});

test('the settings page\'s "Try it" splits a spoken-style phrase into items', async () => {
  const { server, plugin } = await signedIn();
  const out = await plugin.config({ type: 'test', text: 'Please add 2 l milk, 6 eggs and bread to the shopping list.' });
  assert.strictEqual(out.text, 'Added Milk (2 l), Eggs (6) and Bread to Zuhause.');
  assert.deepStrictEqual(lastPut(server).changes.map((c) => [c.itemId, c.spec]), [['Milch', '2 l'], ['Eier', '6'], ['Brot', '']]);
});

test('Bring! is never an Index notes/reminders/agent destination', async () => {
  // Index makes a plugin a destination when it has create_note/create_reminder/send_to_agent plus
  // <category>/configured. The reminders slot would receive every reminder, not just shopping.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).pebble.plugin;
  const actions = manifest.actions.map((a) => a.name);
  for (const name of ['create_note', 'create_reminder', 'send_to_agent']) assert.ok(!actions.includes(name), name);
  for (const source of manifest.sources) assert.ok(!['notes', 'reminders', 'agent'].includes(source.category), source.category);
  const { plugin } = await signedIn();
  assert.strictEqual((await plugin.action('create_reminder', { title: 'Call mom' })).error.code, 'INVALID_REQUEST');
  assert.strictEqual((await plugin.source('reminders', 'configured')).error.code, 'INVALID_REQUEST');
});

test('read_list says what is still to buy', async () => {
  const server = fakeBring();
  server.lists[LIST].purchase = [{ uuid: 'u-1', itemId: 'Milch', specification: '2 l' }, { uuid: 'u-2', itemId: 'Tofu', specification: '' }];
  const { plugin } = await signedIn(server);
  assert.strictEqual((await plugin.action('read_list', {})).ok.text, 'Zuhause: Milk (2 l), Tofu. Other Bring! lists: Party.');
  assert.strictEqual((await plugin.action('read_list', { list: 'Party' })).ok.text, 'Party is empty. Other Bring! lists: Zuhause.');
});

test('parseItems handles German phrasing too', async () => {
  const { context } = load(fakeBring());
  const parse = (t) => JSON.parse(JSON.stringify(context.parseItems(t)));
  assert.deepStrictEqual(parse('Milch, 500 g Mehl und 3 Zitronen auf die Einkaufsliste'), [
    { name: 'Milch', specification: '' }, { name: 'Mehl', specification: '500 g' }, { name: 'Zitronen', specification: '3' },
  ]);
  assert.deepStrictEqual(parse('wir brauchen Brot'), [{ name: 'Brot', specification: '' }]);
  assert.deepStrictEqual(parse('salt & pepper'), [{ name: 'salt', specification: '' }, { name: 'pepper', specification: '' }]);
  assert.deepStrictEqual(parse('  '), []);
  assert.deepStrictEqual(parse('add cheese to Bring'), [{ name: 'cheese', specification: '' }]);
  assert.deepStrictEqual(parse('Butter zur Einkaufsliste hinzufügen'), [{ name: 'Butter', specification: '' }]);
  assert.deepStrictEqual(parse('1,5 l Milch, Brot'), [{ name: 'Milch', specification: '1,5 l' }, { name: 'Brot', specification: '' }]);
});

test('an expired token is renewed before use, and a rejected one once after', async () => {
  const { server, plugin } = await signedIn();
  expireToken(plugin);
  let out = await plugin.action('add_items', { items: [{ name: 'Milk' }] });
  assert.ok(out.ok, JSON.stringify(out));
  assert.strictEqual(storedAuth(plugin).accessToken, 'token-2');
  server.token = 'token-7'; // Bring! revoked token-2 server-side; the next refresh hands out token-8
  out = await plugin.action('add_items', { items: [{ name: 'Eggs' }] });
  assert.ok(out.ok, JSON.stringify(out));
  assert.strictEqual(storedAuth(plugin).accessToken, 'token-8');
});

test('a refused refresh signs out and asks to sign in again', async () => {
  const { server, plugin } = await signedIn();
  server.token = 'token-9';
  server.refreshStatus = 401;
  const out = await plugin.action('add_items', { items: [{ name: 'Milk' }] });
  assert.strictEqual(out.error.code, 'AUTH_REQUIRED');
  assert.strictEqual(plugin.secure.size, 0);
  assert.strictEqual((await plugin.config({ type: 'status' })).signedIn, false);
});

test('without signing in, actions and sources ask for it', async () => {
  const plugin = load(fakeBring());
  assert.strictEqual((await plugin.action('add_items', { items: [{ name: 'Milk' }] })).error.code, 'AUTH_REQUIRED');
  assert.strictEqual((await plugin.source('shopping', 'item')).error.code, 'AUTH_REQUIRED');
});

test('bad arguments are INVALID_ARGS', async () => {
  const { plugin } = await signedIn();
  assert.strictEqual((await plugin.action('add_items', { items: [] })).error.code, 'INVALID_ARGS');
  assert.strictEqual((await plugin.action('add_items', { items: [{ name: ' ' }] })).error.code, 'INVALID_ARGS');
  assert.strictEqual((await plugin.action('complete_item', {})).error.code, 'INVALID_ARGS');
  assert.strictEqual((await plugin.action('nope', {})).error.code, 'INVALID_REQUEST');
});

test('complete_item checks an item off by what the user sees', async () => {
  const server = fakeBring();
  server.lists[LIST].purchase = [{ uuid: 'u-g', itemId: 'Gipfeli', specification: '' }];
  const { plugin } = await signedIn(server);
  const out = await plugin.action('complete_item', { name: 'croissant' });
  assert.strictEqual(out.ok.text, 'Checked off Croissant on Zuhause.');
  assert.deepStrictEqual(lastPut(server).changes.map((c) => [c.itemId, c.uuid, c.operation]), [['Gipfeli', 'u-g', 'TO_RECENTLY']]);
  assert.strictEqual((await plugin.action('complete_item', { name: 'croissant' })).error.code, 'INVALID_ARGS');
});

test('complete_item takes the item id a watch tile shows', async () => {
  const server = fakeBring();
  server.lists[LIST].purchase = [{ uuid: 'u-1', itemId: 'Milch', specification: '' }, { uuid: 'u-2', itemId: 'Tofu', specification: '' }];
  const { plugin } = await signedIn(server);
  const out = await plugin.action('complete_item', { instanceId: 'u-2' });
  assert.strictEqual(out.ok.text, 'Checked off Tofu on Zuhause.');
  assert.deepStrictEqual(server.lists[LIST].purchase.map((i) => i.itemId), ['Milch']);
});

test('sources show the lists (default first) and the default list\'s items, translated', async () => {
  const server = fakeBring();
  server.lists[LIST].purchase = [{ uuid: 'u-1', itemId: 'Milch', specification: '2 l' }, { uuid: 'u-2', itemId: 'Tofu', specification: '' }];
  const { plugin } = await signedIn(server);
  await plugin.config({ type: 'setDefaultList', listUuid: PARTY });
  await plugin.config({ type: 'setDefaultList', listUuid: LIST });
  const lists = (await plugin.source('shopping', 'list')).data.instances;
  assert.deepStrictEqual(lists.map((i) => i.instanceId), [LIST, PARTY]);
  assert.strictEqual(lists[0].properties.items.longText.text, 'Milk (2 l), Tofu');
  assert.strictEqual(lists[0].properties.item_count.numericValue.value, 2);
  assert.strictEqual(lists[1].properties.items.longText.text, 'Nothing to buy');
  const items = (await plugin.source('shopping', 'item')).data.instances;
  assert.deepStrictEqual(items.map((i) => i.properties.name.shortText.text), ['Milk', 'Tofu']);
  assert.strictEqual(items[0].properties.specification.longText.text, '2 l');
  assert.strictEqual(items[1].properties.specification, undefined);
});

test('the chosen default list is used for actions', async () => {
  const { server, plugin } = await signedIn();
  const status = await plugin.config({ type: 'setDefaultList', listUuid: PARTY });
  assert.strictEqual(status.defaultList, PARTY);
  const out = await plugin.action('add_items', { items: [{ name: 'Milch' }] });
  assert.strictEqual(out.ok.text, 'Added Milch to Party.');
  assert.ok(server.requests.some((r) => r.method === 'PUT' && r.url.includes(PARTY)));
});

test('a Swiss list understands German and the account language too', async () => {
  const server = fakeBring();
  server.listLanguages[PARTY] = 'de-CH';
  server.catalogs['de-CH'] = { Rüebli: 'Rüebli', Milch: 'Milch', Müesli: 'Müesli' };
  server.catalogs['de-DE'] = { Rüebli: 'Karotten', Milch: 'Milch', Müesli: 'Müsli' };
  server.catalogs['en-US'] = { Milch: 'Milk', Rüebli: 'Carrots' };
  const { plugin } = await signedIn(server);
  // The fake account's own language is de-DE; make it English like a phone set to English.
  const state = JSON.parse(plugin.local.get('bring.state.v1'));
  plugin.local.set('bring.state.v1', JSON.stringify({ ...state, userLocale: 'en-US' }));
  const out = await plugin.action('add_items', { items: [{ name: 'Karotten' }, { name: 'müsli' }, { name: 'milk' }, { name: 'Zwieback' }], list: 'Party' });
  assert.strictEqual(out.ok.text, 'Added Rüebli, Müesli, Milch and Zwieback to Party.');
  assert.deepStrictEqual(lastPut(server).changes.map((c) => c.itemId), ['Rüebli', 'Müesli', 'Milch', 'Zwieback']);
});

test('without the catalog, items are still added as said', async () => {
  const server = fakeBring({ catalogs: {} });
  const { plugin } = await signedIn(server);
  const out = await plugin.action('add_items', { items: [{ name: 'milk' }] });
  assert.strictEqual(out.ok.text, 'Added Milk to Zuhause.');
  assert.strictEqual(lastPut(server).changes[0].itemId, 'Milk');
});

test('a blocked request says which domain to allow', async () => {
  const { server, plugin } = await signedIn();
  server.fetch = async (url) => {
    throw Object.assign(new Error('not allowed: ' + url), { name: 'NotAllowedError' });
  };
  plugin.local.delete('bring.state.v1');
  const out = await plugin.action('add_items', { items: [{ name: 'Milk' }] });
  assert.strictEqual(out.error.code, 'PLUGIN_UNAVAILABLE');
  assert.match(out.error.message, /isn't allowed to connect to api\.getbring\.com/);
});

test('a dead network is told apart from a missing permission', async () => {
  const { server, plugin } = await signedIn();
  const { context } = plugin;
  server.fetch = async () => { throw new TypeError('fetch failed'); };
  plugin.local.delete('bring.state.v1');
  let out = await plugin.action('add_items', { items: [{ name: 'Milk' }] });
  assert.match(out.error.message, /Could not reach Bring!\. Check the phone's internet connection\./);
  context.Pebble.permissions.query = async (p) => (p === 'Internet/web.getbring.com' ? 'prompt' : 'granted');
  out = await plugin.action('add_items', { items: [{ name: 'Milk' }] });
  assert.match(out.error.message, /isn't allowed to connect to web\.getbring\.com yet/);
  assert.deepStrictEqual(await plugin.config({ type: 'permissions' }), { missing: ['web.getbring.com'] });
});

// Holds the first request whose URL passes `match` until release() is called.
function hold(server, match) {
  const fetch = server.fetch;
  const gate = {};
  gate.started = new Promise((resolve) => (gate.arrived = resolve));
  const held = new Promise((resolve) => (gate.release = resolve));
  let first = true;
  server.fetch = async (url, init) => {
    if (first && match(url)) {
      first = false;
      gate.arrived();
      await held;
    }
    return fetch(url, init);
  };
  return gate;
}

test('signing out while a token renewal is under way stays signed out', async () => {
  const { server, plugin } = await signedIn();
  expireToken(plugin);
  const gate = hold(server, (url) => url === API + 'v2/bringauth/token');
  const pending = plugin.action('add_items', { items: [{ name: 'Milk' }] });
  await gate.started;
  assert.strictEqual((await plugin.config({ type: 'signOut' })).signedIn, false);
  gate.release();
  const out = await pending;
  assert.strictEqual(out.error && out.error.code, 'AUTH_REQUIRED', JSON.stringify(out));
  assert.strictEqual(plugin.secure.size, 0);
  assert.ok(!server.requests.some((r) => r.method === 'PUT'));
  assert.strictEqual((await plugin.config({ type: 'status' })).signedIn, false);
});

test('a sync that was under way keeps the default list picked meanwhile', async () => {
  const { server, plugin } = await signedIn();
  const state = JSON.parse(plugin.local.get('bring.state.v1'));
  plugin.local.set('bring.state.v1', JSON.stringify({ ...state, syncedAt: 1 }));
  const gate = hold(server, (url) => url === API + `bringusers/${USER}/lists`);
  const pending = plugin.source('shopping', 'list');
  await gate.started;
  assert.strictEqual((await plugin.config({ type: 'setDefaultList', listUuid: PARTY })).defaultList, PARTY);
  gate.release();
  assert.ok((await pending).data);
  const out = await plugin.action('add_items', { items: [{ name: 'Milch' }] });
  assert.strictEqual(out.ok.text, 'Added Milch to Party.');
});

test('a sign-out that comes between renewing the token and saving it wins', async () => {
  // The settings page's storage calls can land between this request's own: hold the read that
  // checks the session (it answers with what was stored before the sign-out), or the save itself.
  for (const op of ['getItem', 'setItem']) {
    const { server, plugin } = await signedIn();
    expireToken(plugin);
    let renewed = false;
    const fetch = server.fetch;
    server.fetch = async (url, init) => {
      const reply = await fetch(url, init);
      if (url === API + 'v2/bringauth/token') renewed = true;
      return reply;
    };
    const storage = plugin.context.Pebble.secureStorage;
    const original = storage[op];
    const gate = {};
    gate.started = new Promise((resolve) => (gate.arrived = resolve));
    const held = new Promise((resolve) => (gate.release = resolve));
    let holding = false;
    storage[op] = async (...args) => {
      if (!renewed || holding) return original(...args);
      holding = true;
      gate.arrived();
      if (op === 'getItem') {
        const value = await original(...args);
        await held;
        return value;
      }
      await held;
      return original(...args);
    };
    const pending = plugin.action('add_items', { items: [{ name: 'Milk' }] });
    await gate.started;
    assert.strictEqual((await plugin.config({ type: 'signOut' })).signedIn, false);
    gate.release();
    const out = await pending;
    assert.strictEqual(out.error && out.error.code, 'AUTH_REQUIRED', op + ': ' + JSON.stringify(out));
    assert.strictEqual(plugin.secure.size, 0, op);
    assert.ok(!server.requests.some((r) => r.method === 'PUT'), op);
    assert.strictEqual((await plugin.config({ type: 'status' })).signedIn, false, op);
  }
});

test('a sign-out during a sync leaves no account data behind', async () => {
  const { server, plugin } = await signedIn();
  const state = JSON.parse(plugin.local.get('bring.state.v1'));
  plugin.local.set('bring.state.v1', JSON.stringify({ ...state, syncedAt: 1 }));
  const gate = hold(server, (url) => url === API + `bringusers/${USER}/lists`);
  const pending = plugin.source('shopping', 'list');
  await gate.started;
  await plugin.config({ type: 'signOut' });
  gate.release();
  assert.strictEqual((await pending).error.code, 'AUTH_REQUIRED');
  assert.ok(!plugin.local.has('bring.state.v1'));
  assert.strictEqual(plugin.secure.size, 0);
});

test('a renewal saved late can\'t undo a sign-in made after a sign-out', async () => {
  const { server, plugin } = await signedIn();
  expireToken(plugin);
  let renewed = false;
  const fetch = server.fetch;
  server.fetch = async (url, init) => {
    const reply = await fetch(url, init);
    if (url === API + 'v2/bringauth/token') renewed = true;
    return reply;
  };
  // Hold the renewal's save until the user has signed out and in again.
  const storage = plugin.context.Pebble.secureStorage;
  const setItem = storage.setItem;
  const gate = {};
  gate.started = new Promise((resolve) => (gate.arrived = resolve));
  const held = new Promise((resolve) => (gate.release = resolve));
  let holding = false;
  storage.setItem = async (...args) => {
    if (renewed && !holding) {
      holding = true;
      gate.arrived();
      await held;
    }
    return setItem(...args);
  };
  const pending = plugin.action('add_items', { items: [{ name: 'Milk' }] });
  await gate.started;
  await plugin.config({ type: 'signOut' });
  server.token = 'token-100';
  assert.strictEqual((await plugin.config({ type: 'signIn', email: 'me@example.com', password: 'secret' })).signedIn, true);
  gate.release();
  assert.strictEqual((await pending).error.code, 'AUTH_REQUIRED');
  assert.strictEqual(plugin.secure.size, 1);
  assert.strictEqual(storedAuth(plugin).accessToken, 'token-100');
  assert.strictEqual((await plugin.config({ type: 'status' })).signedIn, true);
  assert.ok((await plugin.action('add_items', { items: [{ name: 'Milk' }] })).ok);
});

test('a sign-in from before sessions had their own keys stays signed in', async () => {
  // 0.1.0 kept the tokens under bring.auth.v1 and had no session counter.
  const server = fakeBring();
  const first = await signedIn(server);
  const plugin = load(server, {
    secure: { 'bring.auth.v1': first.plugin.secure.get(authKeyOf(first.plugin)) },
    local: { 'bring.state.v1': first.plugin.local.get('bring.state.v1') },
  });
  assert.strictEqual((await plugin.config({ type: 'status' })).signedIn, true);
  assert.ok((await plugin.action('add_items', { items: [{ name: 'Milk' }] })).ok);
});

test('a sign-out Bring! forced late can\'t undo the default list of a newer sign-in', async () => {
  const { server, plugin } = await signedIn();
  expireToken(plugin);
  server.refreshStatus = 401;
  // Hold the forced sign-out's token removal until the user has signed in again and picked a list.
  const storage = plugin.context.Pebble.secureStorage;
  const removeItem = storage.removeItem;
  const gate = {};
  gate.started = new Promise((resolve) => (gate.arrived = resolve));
  const held = new Promise((resolve) => (gate.release = resolve));
  let holding = false;
  storage.removeItem = async (...args) => {
    if (!holding) {
      holding = true;
      gate.arrived();
      await held;
    }
    return removeItem(...args);
  };
  const pending = plugin.action('add_items', { items: [{ name: 'Milk' }] });
  await gate.started;
  server.refreshStatus = 200;
  server.token = 'token-100';
  assert.strictEqual((await plugin.config({ type: 'signIn', email: 'me@example.com', password: 'secret' })).signedIn, true);
  assert.strictEqual((await plugin.config({ type: 'setDefaultList', listUuid: PARTY })).defaultList, PARTY);
  gate.release();
  assert.strictEqual((await pending).error.code, 'AUTH_REQUIRED');
  const out = await plugin.action('add_items', { items: [{ name: 'Milch' }] });
  assert.strictEqual(out.ok && out.ok.text, 'Added Milch to Party.', JSON.stringify(out));
});

test('a token read that a new sign-in overtook is read again, not used to sign that one out', async () => {
  const { server, plugin } = await signedIn();
  // Expired tokens without a refresh token: renewing them would sign out.
  plugin.secure.set(authKeyOf(plugin), JSON.stringify({ ...storedAuth(plugin), refreshToken: undefined, expiresAt: 1 }));
  // Hold the reply of the action's first token read until the user has signed out and in again.
  const storage = plugin.context.Pebble.secureStorage;
  const getItem = storage.getItem;
  const gate = {};
  gate.started = new Promise((resolve) => (gate.arrived = resolve));
  const held = new Promise((resolve) => (gate.release = resolve));
  let holding = false;
  storage.getItem = async (...args) => {
    const value = await getItem(...args);
    if (!holding) {
      holding = true;
      gate.arrived();
      await held;
    }
    return value;
  };
  const pending = plugin.action('add_items', { items: [{ name: 'Milk' }] });
  await gate.started;
  await plugin.config({ type: 'signOut' });
  server.token = 'token-100';
  assert.strictEqual((await plugin.config({ type: 'signIn', email: 'me@example.com', password: 'secret' })).signedIn, true);
  gate.release();
  const out = await pending;
  assert.ok(out.ok, JSON.stringify(out)); // it goes on with the new sign-in
  assert.strictEqual(storedAuth(plugin).accessToken, 'token-100');
  assert.strictEqual((await plugin.config({ type: 'status' })).signedIn, true);
});

test('a sign-out stays signed out after the Pebble app was reinstalled', async () => {
  // On iOS the tokens (Keychain) outlive the app, localStorage doesn't: keys from an earlier
  // install, here session 2's, must never be read by a new session.
  const server = fakeBring();
  const earlier = await signedIn(server);
  const tokens = earlier.plugin.secure.get(authKeyOf(earlier.plugin));
  // Keys an earlier install may have left: a counter's, and the clock's around now.
  const left = { 'bring.auth.v1.2': tokens };
  for (let t = Date.now() - 2000; t < Date.now() + 2000; t++) left['bring.auth.v1.' + t] = tokens;
  const plugin = load(server, { secure: left });
  assert.strictEqual((await plugin.config({ type: 'status' })).signedIn, false);
  assert.strictEqual((await plugin.config({ type: 'signIn', email: 'me@example.com', password: 'secret' })).signedIn, true);
  assert.strictEqual((await plugin.config({ type: 'signOut' })).signedIn, false);
  assert.strictEqual((await plugin.config({ type: 'status' })).signedIn, false);
  assert.strictEqual((await plugin.action('add_items', { items: [{ name: 'Milk' }] })).error.code, 'AUTH_REQUIRED');
});

test('a list is picked by its name, never by a word that happens to contain it', async () => {
  const server = fakeBring();
  server.lists['list-shop'] = { name: 'Shop', purchase: [], recently: [] };
  const { plugin } = await signedIn(server);
  const before = server.requests.length;
  let out = await plugin.action('add_items', { items: [{ name: 'Milk' }], list: 'shopping list' });
  assert.strictEqual(out.ok.text, 'Added Milk to Zuhause.');
  // A generic name means the default list, without reloading the account first.
  assert.ok(!server.requests.slice(before).some((r) => r.url.includes('bringusers')));
  out = await plugin.action('add_items', { items: [{ name: 'Milk' }], list: 'Office Party' });
  assert.strictEqual(out.error.code, 'INVALID_ARGS');
  out = await plugin.action('add_items', { items: [{ name: 'Eggs' }], list: 'the shop list' });
  assert.strictEqual(out.ok.text, 'Added Eggs to Shop.');
});

test('add_items only takes list ids, as its targets say', () => {
  // targets are the sources whose instanceId an action takes; add_items treats it as a list.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).pebble.plugin;
  assert.deepStrictEqual(manifest.actions.find((a) => a.name === 'add_items').targets, ['shopping/list']);
});

test('a list deleted in the Bring! app is noticed straight away', async () => {
  const { server, plugin } = await signedIn();
  delete server.lists[PARTY];
  const lists = (await plugin.source('shopping', 'list')).data.instances;
  assert.deepStrictEqual(lists.map((i) => i.instanceId), [LIST]);
  delete server.lists[LIST];
  server.lists['list-new'] = { name: 'Neu', purchase: [], recently: [] };
  const out = await plugin.action('add_items', { items: [{ name: 'Milk' }] });
  assert.strictEqual(out.ok && out.ok.text, 'Added Milk to Neu.', JSON.stringify(out));
});

test('a list whose name sounds generic is reached by that name, with the words around it', async () => {
  const cases = [
    ['Groceries', 'groceries list'], ['Groceries', 'the groceries list'], ['Shopping', 'the shopping list'],
    ['Einkaufsliste', 'die Einkaufsliste'], ['Weekend Shopping', 'weekend shopping list'],
  ];
  for (const [listName, said] of cases) {
    const server = fakeBring();
    server.lists['list-x'] = { name: listName, purchase: [], recently: [] };
    if (listName === 'Weekend Shopping') server.lists['list-w'] = { name: 'Weekend', purchase: [], recently: [] };
    const { plugin } = await signedIn(server);
    const out = await plugin.action('add_items', { items: [{ name: 'Tofu' }], list: said });
    assert.strictEqual(out.ok && out.ok.text, `Added Tofu to ${listName}.`, said + ': ' + JSON.stringify(out));
  }
});

test('of lists with the same name, the default one is used, and otherwise none is guessed', async () => {
  const server = fakeBring();
  server.lists = { 'list-a': { name: 'Party', purchase: [], recently: [] }, 'list-b': { name: 'Party', purchase: [], recently: [] } };
  server.listLanguages = {};
  const { plugin } = await signedIn(server);
  await plugin.config({ type: 'setDefaultList', listUuid: 'list-b' });
  let out = await plugin.action('add_items', { items: [{ name: 'Milk' }], list: 'Party' });
  assert.ok(out.ok, JSON.stringify(out));
  assert.ok(lastPut(server) && server.requests.filter((r) => r.method === 'PUT').pop().url.includes('list-b'));
  server.lists['list-c'] = { name: 'Zuhause', purchase: [], recently: [] };
  await plugin.config({ type: 'refresh' });
  await plugin.config({ type: 'setDefaultList', listUuid: 'list-c' });
  const puts = server.requests.filter((r) => r.method === 'PUT').length;
  out = await plugin.action('add_items', { items: [{ name: 'Milk' }], list: 'the party list' });
  assert.strictEqual(out.error && out.error.code, 'INVALID_ARGS', JSON.stringify(out));
  assert.match(out.error.message, /More than one Bring! list fits/);
  assert.strictEqual(server.requests.filter((r) => r.method === 'PUT').length, puts);
});

test('lists that differ only by "my" and "our" are told apart', async () => {
  const server = fakeBring();
  server.lists = { 'list-my': { name: 'My Groceries', purchase: [], recently: [] }, 'list-our': { name: 'Our Groceries', purchase: [], recently: [] } };
  server.listLanguages = {};
  const { plugin } = await signedIn(server);
  await plugin.config({ type: 'setDefaultList', listUuid: 'list-my' });
  const goesTo = async (said, item) => {
    const out = await plugin.action('add_items', { items: [{ name: item }], list: said });
    assert.ok(out.ok, said + ': ' + JSON.stringify(out));
    return /to (.+)\.$/.exec(out.ok.text)[1];
  };
  assert.strictEqual(await goesTo('our groceries list', 'Tofu'), 'Our Groceries');
  assert.strictEqual(await goesTo('Our Groceries', 'Rice'), 'Our Groceries');
  assert.strictEqual(await goesTo('our groceries', 'Beans'), 'Our Groceries');
  // Without "my" or "our" the words fit both: the default one is used.
  assert.strictEqual(await goesTo('groceries list', 'Salt'), 'My Groceries');
});

test('adding a product that is on the list in several variants changes none of them', async () => {
  const server = fakeBring();
  server.lists[LIST].purchase = [{ uuid: 'u-oat', itemId: 'Milch', specification: 'oat' }, { uuid: 'u-cow', itemId: 'Milch', specification: 'cow' }];
  const { plugin } = await signedIn(server);
  let out = await plugin.action('add_items', { items: [{ name: 'milk', specification: 'cow' }] });
  assert.strictEqual(out.ok.text, 'Milk (cow) is already on Zuhause.');
  assert.ok(!server.requests.some((r) => r.method === 'PUT'));
  out = await plugin.action('add_items', { items: [{ name: 'milk', specification: 'soy' }] });
  assert.strictEqual(out.ok.text, 'Added Milk (soy) to Zuhause.');
  assert.deepStrictEqual(server.lists[LIST].purchase.map((i) => i.specification), ['oat', 'cow', 'soy']);
});

test('one product asked for in several variants at once adds each of them', async () => {
  const server = fakeBring();
  server.lists[LIST].purchase = [{ uuid: 'u-milk', itemId: 'Milch', specification: '' }];
  const { plugin } = await signedIn(server);
  const out = await plugin.action('add_items', {
    items: [{ name: 'Milk', specification: 'oat' }, { name: 'milk' }, { name: 'Milch', specification: 'cow' }, { name: 'Milk', specification: 'Oat' }],
  });
  assert.strictEqual(out.ok.text, 'Added Milk (oat) (updated) and Milk (cow) to Zuhause.');
  assert.deepStrictEqual(server.lists[LIST].purchase.map((i) => [i.uuid === 'u-milk', i.specification]), [[true, 'oat'], [false, 'cow']]);
});

test('a variant already on the list is kept, whatever order the variants are asked for in', async () => {
  for (const order of [['oat', 'cow'], ['cow', 'oat']]) {
    const server = fakeBring();
    server.lists[LIST].purchase = [{ uuid: 'u-oat', itemId: 'Milch', specification: 'oat' }];
    const { plugin } = await signedIn(server);
    const out = await plugin.action('add_items', { items: order.map((specification) => ({ name: 'Milk', specification })) });
    assert.strictEqual(out.ok.text, 'Added Milk (cow) to Zuhause. Milk (oat) was already on it.', order.join());
    assert.deepStrictEqual(server.lists[LIST].purchase.map((i) => [i.uuid === 'u-oat', i.specification]).sort(),
      [[false, 'cow'], [true, 'oat']], order.join());
  }
});

test('a variant in "recently used" moves back as it is, and other saved variants are left alone', async () => {
  const saved = () => [{ uuid: 'r-oat', itemId: 'Milch', specification: 'oat' }, { uuid: 'r-cow', itemId: 'Milch', specification: 'cow' }];
  let server = fakeBring();
  server.lists[LIST].recently = saved();
  let plugin = (await signedIn(server)).plugin;
  let out = await plugin.action('add_items', { items: [{ name: 'Milk', specification: 'cow' }] });
  assert.strictEqual(out.ok.text, 'Added Milk (cow) to Zuhause.');
  assert.deepStrictEqual(lastPut(server).changes.map((c) => [c.uuid, c.spec]), [['r-cow', 'cow']]);
  assert.deepStrictEqual(server.lists[LIST].recently.map((i) => [i.uuid, i.specification]), [['r-oat', 'oat']]);
  // Several variants saved: none of them is turned into another one, whatever the order asked in.
  for (const [asked, kept] of [[['soy', 'oat'], 'cow'], [['oat', 'soy'], 'cow'], [['cow', 'soy'], 'oat'], [['soy', 'cow'], 'oat']]) {
    server = fakeBring();
    server.lists[LIST].recently = saved();
    plugin = (await signedIn(server)).plugin;
    out = await plugin.action('add_items', { items: asked.map((specification) => ({ name: 'Milk', specification })) });
    assert.ok(out.ok, asked.join() + ': ' + JSON.stringify(out));
    assert.deepStrictEqual(server.lists[LIST].recently.map((i) => i.specification), [kept], asked.join());
    assert.deepStrictEqual(server.lists[LIST].purchase.map((i) => i.specification).sort(), [...asked].sort(), asked.join());
    const moved = server.lists[LIST].purchase.find((i) => i.specification !== 'soy');
    assert.strictEqual(moved.uuid, 'r-' + moved.specification, asked.join());
  }
});

test('asking again for a variant that was checked off moves it back, and the other one stays', async () => {
  const server = fakeBring();
  const { plugin } = await signedIn(server);
  await plugin.action('add_items', { items: [{ name: 'Milk', specification: 'oat' }, { name: 'Milk', specification: 'cow' }] });
  const cow = server.lists[LIST].purchase.find((i) => i.specification === 'cow');
  assert.ok((await plugin.action('complete_item', { instanceId: cow.uuid })).ok);
  const out = await plugin.action('add_items', { items: [{ name: 'Milk', specification: 'cow' }] });
  assert.strictEqual(out.ok.text, 'Added Milk (cow) to Zuhause.');
  assert.deepStrictEqual(server.lists[LIST].purchase.map((i) => i.specification).sort(), ['cow', 'oat']);
  assert.deepStrictEqual(server.lists[LIST].recently, []);
});

test('a sign-in whose lists fail to load still signs in, and says what went wrong', async () => {
  const server = fakeBring();
  const fetch = server.fetch;
  let failing = true;
  server.fetch = async (url, init) => (failing && url.startsWith(API + 'bringusersettings/')
    ? { status: 500, text: async () => 'oops' } : fetch(url, init));
  const plugin = load(server);
  const result = await plugin.config({ type: 'signIn', email: 'me@example.com', password: 'secret' });
  assert.strictEqual(result.signedIn, true);
  assert.match(result.error, /HTTP 500/);
  failing = false;
  assert.deepStrictEqual((await plugin.config({ type: 'refresh' })).lists.map((l) => l.name), ['Zuhause', 'Party']);
});
