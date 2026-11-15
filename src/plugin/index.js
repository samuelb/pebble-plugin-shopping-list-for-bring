// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Samuel Barabas
//
// Shopping List for Bring!: a Pebble plugin that adds to Bring! shopping lists from Pebble
// watches and the Index 01 ring.
//
// Unofficial, and not affiliated with, endorsed or sponsored by Bring! Labs AG. Bring! has no
// public API; this uses the REST API Bring!'s own apps use (api.getbring.com), which may change at
// any time. The user signs in with their Bring! email and password on the settings page; the
// password goes to Bring! once and is never stored. Only the tokens Bring! hands back are kept, in
// Pebble.secureStorage. Nothing is sent anywhere but Bring!.
//
// The plugin is started fresh for every request, so everything it needs to remember lives in
// secureStorage (tokens) or localStorage (lists, list languages, the catalog cache).

var API_ROOT = 'https://api.getbring.com/rest/';
var CATALOG_ROOT = 'https://web.getbring.com/locale/articles.';
// The client key Bring!'s web app sends with every request; it names the app, not the user.
var API_KEY = 'cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp';

var AUTH_KEY = 'bring.auth.v1'; // secureStorage, + '.' + session after the first sign-in
var STATE_KEY = 'bring.state.v1'; // localStorage
var SESSION_KEY = 'bring.session.v1'; // localStorage, changes on every sign-in and sign-out
var CATALOG_KEY = 'bring.catalog.v1.'; // localStorage, + locale

var STATE_TTL_MS = 60 * 60 * 1000;
var CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var SOURCE_TTL_MS = 5 * 60 * 1000;
var MAX_ITEMS_PER_ACTION = 50;

// Deliberately not an Index notes/reminders destination (no create_reminder, no reminders/*):
// that slot would also receive every reminder. Index reaches Bring! through the actions instead.
var SOURCES = ['shopping/list', 'shopping/item'];
var CHANGED = SOURCES;

// Locales Bring! has catalog translations for, and the fallback for bare languages.
var SUPPORTED_LOCALES = [
  'de-AT', 'de-CH', 'de-DE', 'en-AU', 'en-CA', 'en-GB', 'en-US', 'es-ES', 'fr-CH', 'fr-FR',
  'hu-HU', 'it-CH', 'it-IT', 'nb-NO', 'nl-NL', 'pl-PL', 'pt-BR', 'ru-RU', 'sv-SE', 'tr-TR',
];
var LANGUAGE_LOCALES = {
  de: 'de-DE', en: 'en-US', es: 'es-ES', fr: 'fr-FR', hu: 'hu-HU', it: 'it-IT', nb: 'nb-NO',
  nl: 'nl-NL', pl: 'pl-PL', pt: 'pt-BR', ru: 'ru-RU', sv: 'sv-SE', tr: 'tr-TR',
};
var DEFAULT_LOCALE = 'de-CH';

// The only hosts the plugin talks to (declared as Internet permissions in package.json).
var DOMAINS = ['api.getbring.com', 'web.getbring.com'];

// ---------------------------------------------------------------------------------------------
// Errors

function fail(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function signInError() {
  return fail('AUTH_REQUIRED', 'Sign in to Bring! on the plugin\'s settings page.');
}

function tooSlowError() {
  return fail('TIMEOUT', 'Bring! didn\'t answer in time. The phone\'s internet connection may be slow.');
}

// ---------------------------------------------------------------------------------------------
// Time: the Pebble app waits 20 s for the answer to an action or a source request, then gives up
// with a bare "plugin did not respond". fetch has no timeout of its own and plugins get no timers,
// so on a slow connection each request here could take longer than that. Instead, a request gets
// a deadline: work that can be done without (renewing the account's lists, downloading catalogs)
// leaves time for the rest, no request starts too late to finish, and where the engine can abort
// one (Android) it's aborted at the deadline. Then the plugin says what went wrong, in time.

var ANSWER_WITHIN_MS = 16 * 1000;
var KEEP_FOR_THE_REST_MS = 6 * 1000;
var SHORTEST_REQUEST_MS = 2 * 1000;

// Set by the action and source handlers. The settings page has minutes, and no deadline.
var deadline = Infinity;

// Runs optional work with the deadline brought forward, so what has to come after it still has
// time. A session serves one request, step by step, so nothing else sees the earlier deadline.
async function leavingTime(work) {
  var own = deadline;
  deadline = own - KEEP_FOR_THE_REST_MS;
  try {
    return await work();
  } finally {
    deadline = own;
  }
}

// A signal that aborts after ms, where the engine has AbortSignal.timeout (Android's WebView).
// JavaScriptCore on iOS has none: there a request can't be cut short, only kept from starting.
function timeoutSignal(ms) {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(Math.max(1, Math.floor(ms))) : null;
  } catch (e) {
    return null;
  }
}

// fetch, if it can still finish by the deadline. Throws tooSlowError() when it can't.
async function timedFetch(url, init) {
  var left = deadline - Date.now();
  if (left < SHORTEST_REQUEST_MS) throw tooSlowError();
  var signal = isFinite(left) ? timeoutSignal(left) : null;
  if (signal) init = Object.assign({}, init, { signal: signal });
  try {
    return await fetch(url, init);
  } catch (e) {
    if (!signal || !signal.aborted) throw e;
    var late = tooSlowError();
    late.sent = true;
    throw late;
  }
}

// ---------------------------------------------------------------------------------------------
// Storage

function readLocal(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.log('Bring: could not save ' + key + ': ' + e);
  }
}

// The settings page runs in a session of its own, alongside the one serving actions and sources,
// and their storage calls interleave. So every sign-in and sign-out starts a new session (an id in
// localStorage, which is synchronous), and each session keeps its tokens under a key of its own:
// work left over from an earlier session can tell it's stale, and can only write to (and clean
// up) that session's key. The id is random, as on iOS the tokens (Keychain) outlive a reinstall of
// the Pebble app but localStorage doesn't. No session yet means a sign-in from 0.1.0.
function currentSession() {
  return readLocal(SESSION_KEY, 0);
}

function authKey(session) {
  return session ? AUTH_KEY + '.' + session : AUTH_KEY;
}

// Ends the current session, its tokens and its state, and returns the new one. It switches before
// the first await, so from then on nothing left over from the old session can save anything.
async function newSession() {
  var previous = currentSession();
  var session = newUuid();
  writeLocal(SESSION_KEY, session);
  writeLocal(STATE_KEY, null);
  await Pebble.secureStorage.removeItem(authKey(previous));
  return session;
}

// The current sign-in's tokens, tagged with the session they were read for (not saved with them).
async function loadAuth() {
  var session = currentSession();
  try {
    var raw = await Pebble.secureStorage.getItem(authKey(session));
    var auth = raw ? JSON.parse(raw) : null;
    if (!auth || !auth.accessToken || !auth.uuid) return null;
    auth.session = session;
    return auth;
  } catch (e) {
    return null;
  }
}

async function saveAuth(auth, session) {
  await Pebble.secureStorage.setItem(authKey(session), JSON.stringify(auth));
}

// Signs out. Given the session a caller began in, only if that is still the current one.
async function clearAuth(session) {
  if (session !== undefined && session !== currentSession()) return;
  await newSession();
}

// { lists: [{ uuid, name }], listLocales: { uuid: locale }, userLocale, country,
//   accountDefaultList, chosenList, syncedAt }
function loadState() {
  return readLocal(STATE_KEY, null) || { lists: [], listLocales: {} };
}

function saveState(state) {
  writeLocal(STATE_KEY, state);
}

// ---------------------------------------------------------------------------------------------
// Permissions: when a request can't get through, say whether the user still has to allow a
// domain or the network is down, instead of a bare "network error".

// The declared domains the Pebble app says aren't allowed (yet). Empty when all are, or when this
// app version can't tell (Pebble.permissions exists from mobile app 1.17).
async function domainsNotAllowed() {
  var permissions = Pebble.permissions;
  if (!permissions || typeof permissions.query !== 'function') return [];
  var missing = [];
  for (var i = 0; i < DOMAINS.length; i++) {
    var state;
    try {
      state = await permissions.query('Internet/' + DOMAINS[i]);
    } catch (e) {
      state = 'granted'; // Unknown: don't send the user looking for a setting that may be fine.
    }
    if (state !== 'granted') missing.push(DOMAINS[i]);
  }
  return missing;
}

function permissionMessage(domains) {
  return 'This plugin isn\'t allowed to connect to ' + domains.join(' and ') +
    ' yet. Allow it under Permissions on the plugin\'s page in the Pebble app.';
}

// For a request to api.getbring.com that got no answer at all.
async function networkError(error) {
  var missing = error && error.name === 'NotAllowedError' ? ['api.getbring.com'] : await domainsNotAllowed();
  return fail('PLUGIN_UNAVAILABLE', missing.length
    ? permissionMessage(missing)
    : 'Bring! can\'t be reached. Check the phone\'s internet connection.');
}

// ---------------------------------------------------------------------------------------------
// HTTP

function formBody(fields) {
  return Object.keys(fields).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(fields[key]);
  }).join('&');
}

function headersFor(auth, country) {
  var headers = {
    'Accept': 'application/json',
    'X-BRING-API-KEY': API_KEY,
    'X-BRING-CLIENT': 'android',
    'X-BRING-APPLICATION': 'bring',
    'X-BRING-COUNTRY': country || 'DE',
  };
  if (auth) {
    headers['X-BRING-USER-UUID'] = auth.uuid;
    if (auth.publicUuid) headers['X-BRING-PUBLIC-USER-UUID'] = auth.publicUuid;
    headers['Authorization'] = 'Bearer ' + auth.accessToken;
  }
  return headers;
}

// One request, no retries. body: undefined, a string (form-encoded) or an object (JSON).
async function send(method, path, body, auth) {
  var headers = headersFor(auth, loadState().country);
  var payload;
  if (typeof body === 'string') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
    payload = JSON.stringify(body);
  }
  var response;
  try {
    response = await timedFetch(API_ROOT + path, { method: method, headers: headers, body: payload });
  } catch (e) {
    console.log('Bring: ' + method + ' ' + path + ' failed: ' + e);
    if (e.code === 'TIMEOUT' && !e.sent) throw e;
    var error = e.code === 'TIMEOUT' ? e : await networkError(e);
    // Sent, maybe, but never answered: Bring! may or may not have made the change. Says how.
    if (e.name !== 'NotAllowedError') error.unanswered = method;
    throw error;
  }
  var text = '';
  try {
    text = await response.text();
  } catch (e) {
    // The status alone is enough for the callers that don't read a body.
  }
  var json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    // Non-JSON bodies (e.g. empty 204s) are fine.
  }
  return { status: response.status, json: json, text: text };
}

function authFromToken(json, previous) {
  previous = previous || {};
  var expiresIn = Number(json.expires_in);
  return {
    uuid: json.uuid || previous.uuid,
    publicUuid: json.publicUuid || previous.publicUuid,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + (isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    email: json.email || previous.email || '',
    name: json.name || previous.name || '',
    defaultList: json.bringListUUID || previous.defaultList || '',
  };
}

// auth as loadAuth (or this) returns it, tagged with its session.
async function refreshAuth(auth) {
  var session = auth.session; // which may have ended since the tokens were read
  if (!auth.refreshToken) {
    await clearAuth(session);
    throw signInError();
  }
  var response = await send(
    'POST',
    'v2/bringauth/token',
    formBody({ grant_type: 'refresh_token', refresh_token: auth.refreshToken }),
    auth
  );
  // The user may have signed out or in again while this was on its way.
  var stored = await loadAuth();
  if (currentSession() !== session || !stored) throw signInError();
  // The settings page may have refreshed meanwhile: use that.
  if (stored.accessToken !== auth.accessToken) return stored;
  if (response.status >= 200 && response.status < 300 && response.json && response.json.access_token) {
    var refreshed = authFromToken(response.json, auth);
    await saveAuth(refreshed, session);
    // A sign-out that crossed the save wins: take back what this wrote under its session's key.
    if (currentSession() !== session) {
      await Pebble.secureStorage.removeItem(authKey(session));
      throw signInError();
    }
    refreshed.session = session;
    return refreshed;
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    await clearAuth(session);
    throw fail('AUTH_REQUIRED', 'Bring! signed this plugin out. Sign in again on its settings page.');
  }
  throw httpError(response, 'renew the Bring! sign-in');
}

function httpError(response, operation) {
  console.log('Bring: failed to ' + operation + ': HTTP ' + response.status + ' ' + response.text);
  var error;
  if (response.status === 401 || response.status === 403) error = signInError();
  else if (response.status === 429) error = fail('RATE_LIMITED', 'Bring! is rate-limiting requests. Try again in a minute.');
  else error = fail('PLUGIN_UNAVAILABLE', 'Bring! couldn\'t ' + operation + ' (HTTP ' + response.status + ').');
  error.status = response.status;
  return error;
}

function unreadableError(operation) {
  return fail('PLUGIN_UNAVAILABLE', 'Bring!\'s answer couldn\'t be read while trying to ' + operation + '.');
}

// An authorized request: renews the token when it has expired or Bring! rejects it once. Given
// the session a caller began in, only with that sign-in's tokens, never a newer one's.
async function api(method, path, body, operation, session) {
  var signedInAs = function (auth) {
    if (!auth || (session !== undefined && auth.session !== session)) throw signInError();
    return auth;
  };
  var auth = signedInAs(await loadAuth());
  if (!auth.expiresAt || Date.now() > auth.expiresAt - 60 * 1000) auth = signedInAs(await refreshAuth(auth));
  var response = await send(method, path, body, auth);
  if (response.status === 401) {
    auth = signedInAs(await refreshAuth(auth));
    response = await send(method, path, body, auth);
  }
  if (response.status < 200 || response.status >= 300) throw httpError(response, operation);
  // An answer that isn't JSON would read as an empty list, and lead to duplicates or lost lists.
  if (method === 'GET' && !(response.json && typeof response.json === 'object')) {
    console.log('Bring: failed to ' + operation + ': unreadable answer ' + response.text);
    throw unreadableError(operation);
  }
  return response.json;
}

// ---------------------------------------------------------------------------------------------
// Account: lists, their article languages, the default list

function localeFor(language, country) {
  var locale = String(language || '').toLowerCase() + '-' + String(country || '').toUpperCase();
  if (SUPPORTED_LOCALES.indexOf(locale) >= 0) return locale;
  return LANGUAGE_LOCALES[String(language || '').toLowerCase()] || DEFAULT_LOCALE;
}

function settingsMap(entries) {
  var map = {};
  (entries || []).forEach(function (entry) {
    if (entry && typeof entry.key === 'string') map[entry.key] = entry.value;
  });
  return map;
}

async function syncAccount() {
  var auth = await loadAuth();
  if (!auth) throw signInError();
  var previous = loadState();
  var account = await api('GET', 'v2/bringusers/' + encodeURIComponent(auth.uuid), undefined, 'load your account');
  var settings = await api('GET', 'bringusersettings/' + encodeURIComponent(auth.uuid), undefined, 'load your settings');
  var lists = await api('GET', 'bringusers/' + encodeURIComponent(auth.uuid) + '/lists', undefined, 'load your lists');
  // Not "no lists": the cached ones are better than none.
  if (!Array.isArray(lists.lists)) throw unreadableError('load your lists');

  var userLocale = account && account.userLocale || {};
  var state = {
    lists: lists.lists
      .filter(function (list) { return list && typeof list.listUuid === 'string' && list.listUuid; })
      .map(function (list) { return { uuid: list.listUuid, name: String(list.name || '').trim() || 'Shopping list' }; }),
    listLocales: {},
    userLocale: localeFor(userLocale.language, userLocale.country),
    country: String(userLocale.country || previous.country || 'DE').toUpperCase(),
    accountDefaultList: settingsMap(settings && settings.usersettings).defaultListUUID || auth.defaultList || '',
    syncedAt: Date.now(),
  };
  ((settings && settings.userlistsettings) || []).forEach(function (entry) {
    var language = settingsMap(entry && entry.usersettings).listArticleLanguage;
    if (entry && entry.listUuid && SUPPORTED_LOCALES.indexOf(language) >= 0) {
      state.listLocales[entry.listUuid] = language;
    }
  });
  // The settings page may have signed out, signed in again or picked another default list while
  // this loaded. Check and save with no await in between, so nothing can come between them.
  if (currentSession() !== auth.session) throw signInError();
  state.chosenList = loadState().chosenList || '';
  saveState(state);
  return state;
}

async function freshState(force) {
  var state = loadState();
  if (force || !state.syncedAt || Date.now() - state.syncedAt > STATE_TTL_MS || !state.lists.length) {
    try {
      // With lists to fall back on, renewing them mustn't take the time the request needs.
      state = force || !state.lists.length ? await syncAccount() : await leavingTime(syncAccount);
    } catch (e) {
      // A stale list of lists is better than failing, as long as there is one.
      if (e.code === 'AUTH_REQUIRED' || !state.lists.length) throw e;
      console.log('Bring: using cached lists: ' + e.message);
    }
  }
  return state;
}

function hasList(state, uuid) {
  return !!uuid && state.lists.some(function (list) { return list.uuid === uuid; });
}

function defaultListUuid(state) {
  if (hasList(state, state.chosenList)) return state.chosenList;
  if (hasList(state, state.accountDefaultList)) return state.accountDefaultList;
  return state.lists.length ? state.lists[0].uuid : '';
}

function listName(state, uuid) {
  for (var i = 0; i < state.lists.length; i++) {
    if (state.lists[i].uuid === uuid) return state.lists[i].name;
  }
  return 'Bring!';
}

function listLocale(state, uuid) {
  return state.listLocales[uuid] || state.userLocale || DEFAULT_LOCALE;
}

// Lists in a stable order with the default first, as Index and watchfaces take instances[0].
function orderedLists(state) {
  var first = defaultListUuid(state);
  return state.lists.slice().sort(function (a, b) {
    return (b.uuid === first) - (a.uuid === first);
  });
}

// Words that mean "the shopping list" rather than naming one of several lists.
var GENERIC_LIST_NAMES = /^(?:(?:my|our|the|meine?|unsere?|die)\s+)?(?:bring!?|shopping|groceries|grocery|einkauf|einkäufe|einkaufen|einkaufsliste|einkaufszettel|list|liste)(?:\s+(?:list|liste))?$/i;

// The words around a list's name when it's said, dropped a step at a time.
var LIST_ARTICLE = /^(?:my|our|the|meine?|unsere?|die)\s+(?=\S)/;
var LIST_SUFFIX = /(\S)\s+(?:list|liste)$/;
var SHOPPING_LIST_SUFFIX = /(\S)\s+(?:(?:shopping|grocery|groceries)\s+(?:list|liste)|einkaufs(?:liste|zettel))$/;

// A name as said, from the strictest form to the loosest, one word dropped at a time: "Our
// weekend shopping list" -> "our weekend shopping list", "our weekend shopping",
// "weekend shopping list", "weekend shopping", "weekend".
function listNameForms(name) {
  var folded = fold(name);
  var bare = folded.replace(LIST_ARTICLE, '');
  return [
    folded,
    folded.replace(LIST_SUFFIX, '$1'),
    bare,
    bare.replace(LIST_SUFFIX, '$1'),
    bare.replace(SHOPPING_LIST_SUFFIX, '$1').replace(LIST_SUFFIX, '$1'),
  ];
}

// { list } with this name or, a step at a time, with this name once the words around it are
// dropped; { several } when the first step that finds any finds more than one (and the default
// list isn't among them); {} when none fits. Whole names only, never a word inside one ("Shop"
// isn't the "shopping list").
function listByName(state, name) {
  var wanted = listNameForms(name);
  var forms = state.lists.map(function (list) { return listNameForms(list.name); });
  for (var step = 0; step < wanted.length; step++) {
    var found = state.lists.filter(function (list, i) { return forms[i][step] === wanted[step]; });
    if (found.length === 1) return { list: found[0] };
    if (found.length) {
      // Of lists that fit as well as each other, the default one is the one the user goes by.
      var preferred = defaultListUuid(state);
      var mine = found.filter(function (list) { return list.uuid === preferred; })[0];
      return mine ? { list: mine } : { several: found };
    }
  }
  return {};
}

// args.list (a name) or args.instanceId (a list uuid, or a name), else the default list.
// With the session the lists were found in, so the request goes on only with that sign-in.
async function resolveList(args) {
  var session = currentSession();
  var state = await freshState(false);
  var id = typeof args.instanceId === 'string' ? args.instanceId.trim() : '';
  var name = typeof args.list === 'string' ? args.list.trim() : '';
  var uuid = '';
  if (id && hasList(state, id)) uuid = id;
  else if (id || name) {
    var wanted = name || id;
    var match = listByName(state, wanted);
    // Not a list we know of, nor a generic name: it may be a list made since the last sync.
    if (!match.list && !match.several && !GENERIC_LIST_NAMES.test(wanted)) {
      state = await freshState(true);
      match = hasList(state, id) ? { list: { uuid: id } } : listByName(state, wanted);
      if (!match.list && !match.several) {
        throw fail('INVALID_ARGS', 'There is no Bring! list called "' + wanted + '". The lists are: ' +
          state.lists.map(function (list) { return list.name; }).join(', ') + '.');
      }
    }
    // Never a guess between lists, generic name or not.
    if (match.several) {
      throw fail('INVALID_ARGS', 'More than one Bring! list fits "' + wanted + '": ' +
        match.several.map(function (list) { return list.name; }).join(', ') + '. Say the whole name.');
    }
    if (match.list) uuid = match.list.uuid;
  }
  uuid = uuid || defaultListUuid(state);
  if (!uuid) throw fail('PLUGIN_UNAVAILABLE', 'Your Bring! account has no lists.');
  return { state: state, uuid: uuid, name: listName(state, uuid), locale: listLocale(state, uuid), session: session };
}

// ---------------------------------------------------------------------------------------------
// Catalog: Bring! stores catalog items by their Swiss German name ("Milch", "Rüebli") and shows
// them translated, so "Milk" on an English list has to be saved as "Milch" to get its icon and
// section. Items not in the catalog are saved as typed.

// Each locale's catalog is read (or downloaded) once per run: one that can't be had isn't asked
// for again for every item.
var catalogs = Object.create(null);

function loadCatalog(locale) {
  return catalogs[locale] || (catalogs[locale] = readCatalog(locale));
}

async function readCatalog(locale) {
  var cached = readLocal(CATALOG_KEY + locale, null);
  if (cached && cached.map && Date.now() - cached.at < CATALOG_TTL_MS) return cached.map;
  try {
    // Items can be added without it, so it mustn't take the time the request needs.
    var response = await leavingTime(function () {
      return timedFetch(CATALOG_ROOT + locale + '.json', { headers: { 'Accept': 'application/json' } });
    });
    if (response.status === 200) {
      var map = JSON.parse(await response.text());
      if (map && typeof map === 'object') {
        writeLocal(CATALOG_KEY + locale, { at: Date.now(), map: map });
        return map;
      }
    }
    console.log('Bring: catalog ' + locale + ' answered HTTP ' + response.status);
  } catch (e) {
    console.log('Bring: catalog ' + locale + ' unavailable: ' + e);
  }
  return cached && cached.map || {};
}

function fold(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// The catalog key for a name in the list's language, or null.
function catalogKey(name, catalog) {
  var wanted = fold(name);
  if (!wanted) return null;
  var keys = Object.keys(catalog);
  for (var i = 0; i < keys.length; i++) {
    if (typeof catalog[keys[i]] === 'string' && fold(catalog[keys[i]]) === wanted) return keys[i];
  }
  for (var j = 0; j < keys.length; j++) {
    if (fold(keys[j]) === wanted) return keys[j];
  }
  return null;
}

function displayName(itemId, catalog) {
  return typeof catalog[itemId] === 'string' ? catalog[itemId] : itemId;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Other catalogs a name may come from: the same language elsewhere ("Karotten" from de-DE for a
// Swiss list, whose catalog calls it "Rüebli"), then the account's language (an English-speaking
// user, or agent, saying "milk" for a German list).
function fallbackLocales(listLocale, userLocale) {
  var language = listLocale.split('-')[0];
  var locales = SUPPORTED_LOCALES.filter(function (locale) {
    return locale !== listLocale && locale.split('-')[0] === language;
  });
  if (userLocale && userLocale !== listLocale && locales.indexOf(userLocale) < 0) locales.push(userLocale);
  return locales;
}

// The catalog key for a name said for this list, or the name as said. Extra catalogs are only
// loaded when the list's own doesn't know the name.
async function itemIdFor(name, list, catalog) {
  var key = catalogKey(name, catalog);
  var others = fallbackLocales(list.locale, list.state.userLocale);
  for (var i = 0; !key && i < others.length; i++) {
    key = catalogKey(name, await loadCatalog(others[i]));
  }
  return key || capitalize(String(name).trim().replace(/\s+/g, ' '));
}

function describe(name, specification) {
  return specification ? name + ' (' + specification + ')' : name;
}

function joinNames(names) {
  if (names.length < 2) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

// ---------------------------------------------------------------------------------------------
// Free text: "2 l milk, eggs and bread" -> three items

var SEPARATORS = /\s*(?:[,;\n+&]|\s(?:and|und|et|y|och|og|sowie|plus|then|dann)\s)\s*/i;
var LEADING_FILLER = /^(?:(?:please|bitte)\s+)?(?:(?:add|buy|get|we need|i need|need|put|kaufen?|kauf|hol(?:e|en)?|wir brauchen|ich brauche|brauche|setz(?:e|en)?|schreib(?:e|en)?)\s+)?/i;
var TRAILING_FILLER = /\s+(?:(?:to|on|onto|in)\s+(?:(?:the|my|our)\s+)?(?:bring!?\s+)?(?:(?:shopping|grocery|groceries)\s+)?(?:list|bring!?)|(?:zur|zu\s+meiner|auf\s+die|auf\s+meine|auf\s+unsere|in\s+die)\s+(?:bring!?[-\s]*)?(?:einkaufsliste|liste|einkaufszettel)(?:\s+(?:hinzu(?:fügen)?|setzen|schreiben|packen))?|hinzu(?:fügen)?)\s*[.!]?$/i;
var QUANTITY = /^(\d+(?:[.,]\d+)?\s*(?:x|kg|g|gr|mg|l|ml|cl|dl|stück|stk|pcs|pieces?|packs?|packungen?|pkg|dosen?|cans?|flaschen?|bottles?|tüten?|bags?|bund|bunches?|becher|gläser|glas|jars?|dozen|dutzend)?\.?)\s+(.+)$/i;

// "2 l milk" -> { name: "milk", specification: "2 l" }
function splitQuantity(part) {
  var match = QUANTITY.exec(part);
  return match ? { name: match[2].trim(), specification: match[1].trim() } : { name: part, specification: '' };
}

function parseItems(text) {
  var cleaned = String(text || '').trim().replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '');
  // A comma between digits is a decimal comma ("1,5 l"), not a separator: keep it out of the split.
  return cleaned.replace(/(\d),(?=\d)/g, '$1\u0000').split(SEPARATORS).map(function (part) {
    part = part.replace(/\u0000/g, ',').trim().replace(/^[-*•]\s*/, '').replace(/[.!?]+$/, '').trim();
    return part ? splitQuantity(part) : null;
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// List contents

// session: the one the caller found the list in (see api).
async function loadItems(listUuid, session) {
  var json = await api('GET', 'v2/bringlists/' + encodeURIComponent(listUuid), undefined, 'load the list', session);
  var items = json.items;
  // Not an empty list: adding to it would make duplicates of what's there.
  if (!items || typeof items !== 'object') throw unreadableError('load the list');
  return {
    purchase: Array.isArray(items.purchase) ? items.purchase : [],
    recently: Array.isArray(items.recently) ? items.recently : [],
  };
}

// The list a request is for, with its catalog and items. A list deleted or left since the last
// sync answers 404: then sync, and resolve the list again (the default may have moved on).
async function openList(args) {
  var list = await resolveList(args);
  var current;
  try {
    current = await loadItems(list.uuid, list.session);
  } catch (e) {
    if (e.status !== 404) throw e;
    var session = list.session;
    await freshState(true);
    list = await resolveList(args);
    list.session = session; // Still the sign-in this request began in.
    current = await loadItems(list.uuid, session);
  }
  return { list: list, catalog: await loadCatalog(list.locale), current: current };
}

function findItem(items, itemId) {
  var wanted = fold(itemId);
  for (var i = 0; i < items.length; i++) {
    if (items[i] && fold(items[i].itemId) === wanted) return items[i];
  }
  return null;
}

function sameSpecification(specifications, specification) {
  return specifications.some(function (other) { return fold(other) === fold(specification); });
}

function newUuid() {
  var bytes = [];
  var cryptoObject = typeof crypto !== 'undefined' ? crypto : null;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return cryptoObject.randomUUID();
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    bytes = Array.prototype.slice.call(cryptoObject.getRandomValues(new Uint8Array(16)));
  } else {
    for (var i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256));
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  var hex = bytes.map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

function change(itemId, specification, uuid, operation) {
  return {
    itemId: itemId,
    spec: specification || '',
    uuid: uuid,
    operation: operation,
    accuracy: '0.0',
    altitude: '0.0',
    latitude: '0.0',
    longitude: '0.0',
  };
}

async function putChanges(listUuid, changes, operation, session) {
  await api('PUT', 'v2/bringlists/' + encodeURIComponent(listUuid) + '/items',
    { changes: changes, sender: '' }, operation, session);
}

// ---------------------------------------------------------------------------------------------
// Actions

function normalizeItems(args) {
  var raw = [];
  if (Array.isArray(args.items)) raw = args.items;
  else if (typeof args.name === 'string') raw = [{ name: args.name, specification: args.specification }];
  var items = [];
  for (var i = 0; i < raw.length; i++) {
    var entry = typeof raw[i] === 'string' ? splitQuantity(raw[i].trim()) : raw[i];
    var name = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) throw fail('INVALID_ARGS', 'Every item needs a name.');
    var specification = entry.specification === undefined || entry.specification === null ? '' : entry.specification;
    if (typeof specification !== 'string') throw fail('INVALID_ARGS', 'specification must be text.');
    items.push({ name: name, specification: specification.trim() });
  }
  return items;
}

async function addItems(args, items) {
  if (!items.length) throw fail('INVALID_ARGS', 'Say what to add, e.g. "milk and 6 eggs".');
  if (items.length > MAX_ITEMS_PER_ACTION) throw fail('INVALID_ARGS', 'That\'s more than ' + MAX_ITEMS_PER_ACTION + ' items at once.');
  try {
    return await addToList(args, items);
  } catch (e) {
    throw notAdded(e, items);
  }
}

// What a failed add says: which items didn't make it, so the user knows what to add again.
function notAdded(error, items) {
  var names = joinNames(items.map(function (item) { return describe(item.name, item.specification); }));
  error.message = error.unanswered === 'PUT'
    ? 'Bring! didn\'t confirm adding ' + names + ': the phone\'s internet connection may be slow or down. ' +
      'Check the list, or try again: nothing is added twice.'
    : 'Couldn\'t add ' + names + '. ' + error.message;
  return error;
}

async function addToList(args, items) {
  var opened = await openList(args);
  var list = opened.list;
  var catalog = opened.catalog;
  var current = opened.current;

  // Each product once, with each of its specifications once. Bring! keeps an entry per
  // specification ("Milk (oat)" and "Milk (cow)"); one said without any is covered by the others.
  var products = [];
  var byId = Object.create(null);
  for (var i = 0; i < items.length; i++) {
    var itemId = await itemIdFor(items[i].name, list, catalog);
    var product = byId[fold(itemId)];
    if (!product) products.push(product = byId[fold(itemId)] = { itemId: itemId, specifications: [] });
    if (!sameSpecification(product.specifications, items[i].specification)) {
      product.specifications.push(items[i].specification);
    }
  }

  var changes = [];
  var added = [];
  var already = [];
  var entriesOf = function (entries, id) {
    return entries.filter(function (entry) { return entry && fold(entry.itemId) === fold(id); });
  };
  products.forEach(function (product) {
    var specifications = product.specifications.length > 1
      ? product.specifications.filter(Boolean) : product.specifications;
    var onList = entriesOf(current.purchase, product.itemId);
    var recently = entriesOf(current.recently, product.itemId);
    var single = specifications.length === 1;
    // The item's only entry on the list may take the details asked for, once: any entry when one
    // variant is asked for, else only one without details yet ("Milk" -> "Milk (oat)").
    var spare = onList.length === 1 && (single || !onList[0].specification) ? onList[0] : null;
    specifications.forEach(function (specification) {
      var same = function (entry) { return fold(entry.specification) === fold(specification); };
      // Already there with nothing new to say: leave it as it is.
      var there = onList.filter(function (entry) { return !specification || same(entry); })[0];
      if (there) {
        already.push(describe(displayName(there.itemId, catalog), there.specification));
        return;
      }
      // Reuse a uuid instead of making a duplicate, in this order: the entry in "recently used"
      // with these details (it moves back as it is, as tapping it in the app does), or any recent
      // one if no details were asked for; the spare entry on the list; asked for one variant only,
      // the item's only recent entry. Otherwise add another rather than change one of several.
      var known = recently.filter(same)[0] || (!specification ? recently[0] : null);
      var updating = known ? null : spare;
      if (updating) spare = null;
      known = known || updating || (single && recently.length === 1 ? recently[0] : null);
      var id = known ? known.itemId : product.itemId;
      var details = specification || (known && known.specification) || '';
      changes.push(change(id, details, (known && known.uuid) || newUuid(), 'TO_PURCHASE'));
      var label = describe(displayName(id, catalog), details);
      added.push(updating ? label + ' (updated)' : label);
    });
  });

  if (changes.length) await putChanges(list.uuid, changes, 'add to the list', list.session);

  var text;
  if (added.length) {
    text = 'Added ' + joinNames(added) + ' to ' + list.name + '.';
    if (already.length) text += ' ' + joinNames(already) + (already.length > 1 ? ' were' : ' was') + ' already on it.';
  } else {
    text = joinNames(already) + (already.length > 1 ? ' are' : ' is') + ' already on ' + list.name + '.';
  }
  return { text: text, refreshed: CHANGED };
}

// By name (as the user says it) or, from a watch tile showing shopping/item, by instanceId.
async function completeItem(args) {
  var name = typeof args.name === 'string' ? args.name.trim() : '';
  var id = typeof args.instanceId === 'string' ? args.instanceId.trim() : '';
  if (!name && !id) throw fail('INVALID_ARGS', 'Say which item to check off.');
  var opened = await openList({ list: args.list });
  var list = opened.list;
  var catalog = opened.catalog;
  var current = opened.current;
  var item = null;
  if (id) {
    item = current.purchase.filter(function (entry) { return entry && (entry.uuid === id || entry.itemId === id); })[0];
  }
  if (!item && name) {
    item = findItem(current.purchase, await itemIdFor(name, list, catalog)) || findItem(current.purchase, name);
  }
  if (!item && name) {
    // Match on what the user sees, e.g. "Croissant" for the catalog item "Gipfeli".
    item = current.purchase.filter(function (entry) {
      return entry && fold(displayName(entry.itemId, catalog)) === fold(name);
    })[0];
  }
  if (!item) throw fail('INVALID_ARGS', (name || 'That item') + ' isn\'t on ' + list.name + '.');
  await putChanges(list.uuid, [change(item.itemId, item.specification || '', item.uuid || null, 'TO_RECENTLY')], 'update the list', list.session);
  return { text: 'Checked off ' + displayName(item.itemId, catalog) + ' on ' + list.name + '.', refreshed: CHANGED };
}

async function readList(args) {
  var opened = await openList(args);
  var list = opened.list;
  var catalog = opened.catalog;
  var names = opened.current.purchase.map(function (item) {
    return describe(displayName(item.itemId, catalog), item.specification);
  });
  var others = list.state.lists.filter(function (l) { return l.uuid !== list.uuid; })
    .map(function (l) { return l.name; });
  return {
    text: (names.length ? list.name + ': ' + names.join(', ') + '.' : list.name + ' is empty.') +
      (others.length ? ' Other Bring! lists: ' + others.join(', ') + '.' : ''),
  };
}

Pebble.registerActionHandler(async function (request, respond) {
  deadline = Date.now() + ANSWER_WITHIN_MS;
  var args = (request && request.args) || {};
  try {
    var result;
    switch (request && request.action) {
      case 'add_items':
        result = await addItems(args, normalizeItems(args));
        break;
      case 'complete_item':
        result = await completeItem(args);
        break;
      case 'read_list':
        result = await readList(args);
        break;
      default:
        throw fail('INVALID_REQUEST', 'Unknown action ' + (request && request.action) + '.');
    }
    respond.ok(result);
  } catch (e) {
    console.log('Bring: ' + (request && request.action) + ' failed: ' + (e && e.message));
    respond.error((e && e.code) || 'UNKNOWN', (e && e.message) || String(e));
  }
});

// ---------------------------------------------------------------------------------------------
// Sources

function shortText(text) {
  return { shortText: { text: String(text) } };
}

function texts(text) {
  return { shortText: { text: String(text) }, longText: { text: String(text) } };
}

function count(value, unit) {
  return {
    numericValue: { value: value, unit: unit },
    shortText: { text: String(value) },
    longText: { text: value + ' ' + unit },
  };
}

async function listsData() {
  var session = currentSession();
  var state = await freshState(false);
  var instances;
  try {
    instances = await listInstances(state, session);
  } catch (e) {
    if (e.status !== 404) throw e;
    // A list was deleted or left since the last sync.
    instances = await listInstances(await freshState(true), session);
  }
  return { validUntilMs: Date.now() + SOURCE_TTL_MS, instances: instances };
}

async function listInstances(state, session) {
  var lists = orderedLists(state);
  var instances = [];
  for (var i = 0; i < lists.length; i++) {
    var locale = listLocale(state, lists[i].uuid);
    var catalog = await loadCatalog(locale);
    var items = await loadItems(lists[i].uuid, session);
    var names = items.purchase.map(function (item) {
      return describe(displayName(item.itemId, catalog), item.specification);
    });
    instances.push({
      instanceId: lists[i].uuid,
      properties: {
        name: texts(lists[i].name),
        item_count: count(names.length, names.length === 1 ? 'item' : 'items'),
        items: { longText: { text: names.length ? names.join(', ') : 'Nothing to buy' } },
      },
    });
  }
  return instances;
}

async function itemsData() {
  var opened = await openList({});
  var list = opened.list;
  var catalog = opened.catalog;
  return {
    validUntilMs: Date.now() + SOURCE_TTL_MS,
    instances: opened.current.purchase.map(function (item) {
      var properties = {
        name: texts(displayName(item.itemId, catalog)),
        list: shortText(list.name),
      };
      if (item.specification) properties.specification = texts(item.specification);
      return { instanceId: item.uuid || item.itemId, properties: properties };
    }),
  };
}

Pebble.registerSourceHandler(async function (request, respond) {
  deadline = Date.now() + ANSWER_WITHIN_MS;
  var key = request && request.category + '/' + request.item;
  try {
    if (key === 'shopping/list') respond.data(await listsData());
    else if (key === 'shopping/item') respond.data(await itemsData());
    else respond.error('INVALID_REQUEST', 'Unsupported source ' + key + '.');
  } catch (e) {
    console.log('Bring: ' + key + ' failed: ' + (e && e.message));
    respond.error((e && e.code) || 'UNKNOWN', (e && e.message) || String(e));
  }
});

// ---------------------------------------------------------------------------------------------
// Settings page

async function status() {
  var auth = await loadAuth();
  if (!auth) return { signedIn: false };
  var state = loadState();
  var error;
  try {
    state = await freshState(false);
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') return { signedIn: false, error: e.message };
    error = e.message;
  }
  var reply = {
    signedIn: true, email: auth.email, name: auth.name, lists: orderedLists(state),
    defaultList: defaultListUuid(state),
  };
  if (error) reply.error = error;
  return reply;
}

async function signIn(email, password) {
  email = String(email || '').trim();
  password = String(password || '');
  if (!email || !password) return { signedIn: false, error: 'Enter your Bring! email and password.' };
  var response = await send('POST', 'v2/bringauth', formBody({ email: email, password: password }));
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
    return { signedIn: false, error: 'Bring! didn\'t accept that email and password.' };
  }
  if (response.status < 200 || response.status >= 300 || !response.json || !response.json.access_token) {
    throw httpError(response, 'sign in');
  }
  await saveAuth(authFromToken(response.json, { email: email }), await newSession());
  // Loads the account, or says what went wrong loading it.
  var result = await status();
  Pebble.refreshSources(SOURCES);
  return result;
}

Pebble.registerConfigHandler(async function (message, respond) {
  try {
    switch (message && message.type) {
      case 'permissions':
        respond({ missing: await domainsNotAllowed() });
        return;
      case 'status':
        respond(await status());
        return;
      case 'signIn':
        respond(await signIn(message.email, message.password));
        return;
      case 'setDefaultList': {
        var state = await freshState(false);
        if (!hasList(state, message.listUuid)) {
          respond({ error: 'That list no longer exists.' });
          return;
        }
        state.chosenList = message.listUuid;
        saveState(state);
        Pebble.refreshSources(SOURCES);
        respond(await status());
        return;
      }
      case 'refresh':
        await freshState(true);
        Pebble.refreshSources(SOURCES);
        respond(await status());
        return;
      case 'test': {
        var result = await addItems({}, parseItems(String(message.text || '')));
        Pebble.refreshSources(CHANGED);
        respond({ text: result.text });
        return;
      }
      case 'signOut':
        await clearAuth();
        Pebble.refreshSources(SOURCES);
        respond({ signedIn: false });
        return;
      default:
        respond({ error: 'Unknown message type.' });
    }
  } catch (e) {
    console.log('Bring: settings ' + (message && message.type) + ' failed: ' + (e && e.message));
    respond({ error: (e && e.message) || String(e) });
  }
});
