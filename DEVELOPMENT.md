# Development

How the plugin works, and how to build, test and publish it. For what it does and how users install it, see
[README.md](README.md).

It's a [Pebble plugin](https://developer.repebble.com/guides/plugins/preview/): JavaScript that runs on the phone
inside the Pebble app and serves data and actions to watch apps and to the Index agent.

## Interface

| | |
|---|---|
| **Actions (Index agent tools)** | `add_items`, `complete_item`, `read_list`. Index exposes each as `<sanitized displayName>__<action>`, here `Shopping_List_for_Bring___add_items` etc. |
| **Sources (watchfaces/apps)** | `shopping/list` (each list: `name`, `item_count`, `items`) and `shopping/item` (default list: `name`, `specification`, `list`). |

On purpose, the plugin is **not** an Index notes/reminders destination: no `create_reminder`, no `reminders/*`
sources. Index has one destination slot for both lists and reminders, so a destination would also get every
reminder. A test fails if one of these is added. Index's built-in `create_list_item` and its undeletable
"Shopping" list compete with `add_items`. The `add_items` description tells the agent to prefer it for anything
to buy.

Index turns each action's `description` into the tool description, and the plugin `description` is used when
the agent searches its tools. Word both for the model. Every top-level parameter needs a `type`, or Index drops
the tool.

Names are matched with Bring!'s catalog in this order: the list's language (`listArticleLanguage`), the same
language elsewhere (e.g. `de-DE` for a `de-CH` list), then the account's language. Unknown names are added as
said, with the first letter capitalised.

## Layout

- `package.json`: manifest. The `pebble.plugin` block declares sources, actions and their JSON Schemas.
- `src/plugin/index.js`: the plugin. It runs in a fresh JS session per request, so state lives in
  `Pebble.secureStorage` (tokens) and `localStorage` (lists, list languages, catalog cache).
- `src/config.html`: settings page (sign in, default list, try it). It may only load from the declared domains,
  so the icon is inline SVG.
- `test/plugin.test.cjs`: unit tests. `scripts/try.mjs`: live harness.
- `store/`: the store icon (`icon.svg`) and its PNG renders.

## Build and sideload

Needs Pebble SDK 4.44+ and pebble-tool 5.1+ (`uv tool install pebble-tool && pebble sdk install latest`).

```sh
pebble build                        # -> build/<folder name>.pbw
pebble install --emulator emery     # or --phone <ip>, or open the .pbw on the phone
pebble plugins list --emulator emery
pebble logs                         # the plugin's console.log lines show up here
```

A sideloaded plugin shows a generic placeholder icon. The Pebble app takes plugin icons only from the store
listing.

## Test

```sh
npm test                            # unit tests against a fake Bring! server (Node 18+)
```

`scripts/try.mjs` runs the plugin script against the real Bring! API with a stand-in Pebble runtime. It writes to
real lists, so use a clearly named test item and remove it afterwards. The sign-in token is kept in a private
file in the system temp directory until `signout`.

```sh
BRING_EMAIL=you@example.com BRING_PASSWORD='…' node scripts/try.mjs signin
node scripts/try.mjs status
node scripts/try.mjs match milk Müsli          # dry run: how names would be stored
node scripts/try.mjs add "2 l milk, eggs"      # like "Try it" on the settings page
node scripts/try.mjs action add_items '{"items":[{"name":"Milk","specification":"2 l"}]}'
node scripts/try.mjs action read_list '{}'
node scripts/try.mjs action complete_item '{"name":"milk"}'
node scripts/try.mjs source shopping item
node scripts/try.mjs remove "Milch"            # delete a test item completely
node scripts/try.mjs signout
```

## Publish

```sh
pebble login
npm run publish-store               # pebble publish --icon-small store/icon-80.png --icon-large store/icon-144.png
```

The first run creates the store listing and asks for a name, description and plugin category. The icons only
apply then; change them later in the [developer dashboard](https://developer.repebble.com/dashboard). In
pebble-tool 5.1.2 the listing goes public right away, whatever `--is-published` says. For a new release, raise
`version` in `package.json` and run `pebble publish --release-notes "…"`.

Text for the listing:

> Add things to your Bring! shopping lists by voice with the Index 01 ring, and show them on your Pebble.
> Sign in with your Bring! account on the settings page. Items are matched with Bring!'s catalog, so they get
> their icon and section.
>
> Unofficial: not affiliated with, endorsed or sponsored by Bring! Labs AG. Bring! is a trademark of Bring!
> Labs AG. Uses Bring!'s web API, which can change at any time. Your password goes only to Bring! and isn't
> stored.

## Icon

`store/icon.svg` is the plugin's own icon: a shopping cart with a plus, deliberately unlike Bring!'s logo. Don't
use Bring!'s logo or artwork (see [NOTICE](NOTICE)). Render the PNGs with:

```sh
for s in 256 144 80; do rsvg-convert -w $s -h $s store/icon.svg -o store/icon-$s.png; done
```

## Bring! API notes

Unofficial and undocumented. It can change without notice.

- Requests carry the web app's client key (`X-BRING-API-KEY`) and, once signed in, `Authorization: Bearer`,
  `X-BRING-USER-UUID` and `X-BRING-PUBLIC-USER-UUID`.
- Sign in: `POST rest/v2/bringauth` (form `email`, `password`). Renew: `POST rest/v2/bringauth/token`
  (`grant_type=refresh_token`).
- Account: `GET rest/v2/bringusers/{uuid}` (`userLocale`). Lists: `GET rest/bringusers/{uuid}/lists`. Settings:
  `GET rest/bringusersettings/{uuid}` (`defaultListUUID`, per-list `listArticleLanguage`).
- Items: `GET rest/v2/bringlists/{list}`. Changes: `PUT rest/v2/bringlists/{list}/items` with
  `{changes: [{itemId, spec, uuid, operation: TO_PURCHASE|TO_RECENTLY|REMOVE}], sender: ""}`.
- Catalog: `https://web.getbring.com/locale/articles.{locale}.json`, mapping each catalog key (Swiss German) to
  its local name.

Learned from [bring-api](https://github.com/miaucl/bring-api) (MIT), the library behind Home Assistant's Bring!
integration. No code from it is included.

## Platform references

- [Plugins guide](https://developer.repebble.com/guides/plugins/preview/) and
  [publishing plugins](https://developer.repebble.com/guides/plugins/publishing-plugins/).
- [coredevices/pebble-apps](https://github.com/coredevices/pebble-apps): Core's example plugins. They have no
  license, so read them, don't copy them.
- [coredevices/mobileapp](https://github.com/coredevices/mobileapp) (GPL-3.0): how the Pebble app and Index
  actually load plugins and turn actions into agent tools.
