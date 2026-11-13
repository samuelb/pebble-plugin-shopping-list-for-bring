# Shopping List for Bring!

A [Pebble plugin](https://developer.repebble.com/guides/plugins/preview/) that adds things to your
[Bring!](https://www.getbring.com) shopping lists from the Index 01 ring and shows them on your Pebble.

> **Unofficial.** Not affiliated with, endorsed, sponsored or approved by Bring! Labs AG. "Bring!" is a
> trademark of Bring! Labs AG and is used here only to say which service this works with. Bring! has no public
> API. The plugin uses the same web API as Bring!'s own apps, which Bring! Labs can change or block at any
> time. Use it at your own risk. See [Legal](#legal).

## What it does

| | |
|---|---|
| **Index agent tools** | `add_items`, `complete_item`, `read_list`. Index exposes them as `Shopping_List_for_Bring___add_items` etc. |
| **Data for watchfaces/apps** | `shopping/list` (each list: `name`, `item_count`, `items`) and `shopping/item` (default list: `name`, `specification`, `list`). |

The plugin is only for shopping. On purpose, it is **not** an Index notes/reminders destination: no
`create_reminder` and no `reminders/*` sources. Index has one slot for both lists and reminders, so a
destination would get every reminder too.

Names are matched with Bring!'s catalog. The plugin tries your list's language first, then the same language
elsewhere, then your account's language. On a Swiss list, "milk", "Müsli" and "Croissant" become `Milch`,
`Müesli` and `Gipfeli`, so they get their icon and section. Anything else is added as said. An item already on
the list isn't added twice. An item in "recently used" moves back to the list, the way tapping it in the app
does.

## Use it

1. In the Pebble app (1.18 or later): **Settings → Plugins → Plugins / permissions preview** on.
2. Install the `.pbw` (see Build). Allow both `getbring.com` domains when asked.
3. Open the settings page from **Apps → Plugins → Shopping List for Bring!**. Sign in with your Bring! email
   and password, then pick the default list. If you sign in to Bring! with Google or Apple, set a password in
   the Bring! app first.
4. Use **Try it** on the settings page to add something and check it lands in Bring!.

### With Index

The Index agent reaches Bring! through the `add_items` tool. Its description tells the agent to use it, not
Index's built-in `create_list_item`, for anything to buy, even when you say "shopping list" or
"Einkaufsliste". Reminders and to-dos stay with your reminders destination.

Index also has a built-in "Shopping" list, which can't be deleted, and its own list tool. The agent picks
between the two tools, so a vague "add milk to the list" could still land in Index's list. Saying "Bring" makes
it certain: "Add milk and two packs of butter to Bring", "Setz Müsli auf die Bring-Liste".

### On the watch

Plugins don't have their own watch UI. Any plugin-aware watchface or app can show `shopping/list` and
`shopping/item`. With **Dashboard (Plugin Demo)**, for example, a tile can show the item count. A tile on a
`shopping/item` can call `complete_item` to check that item off.

## Privacy

Your Bring! password goes only to Bring!. Your lists only move between your phone and Bring!. Nothing reaches
the author or any other server. Details in [PRIVACY.md](PRIVACY.md).

## Build

Needs Pebble SDK 4.44+ and pebble-tool 5.1+ (`uv tool install pebble-tool && pebble sdk install latest`).

```sh
pebble build                        # -> build/<folder name>.pbw
pebble install --emulator emery     # or --phone <ip>, or open the .pbw on your phone
pebble plugins list --emulator emery
pebble logs                         # plugin console.log lines show up here
```

## Publish

```sh
pebble login
npm run publish-store               # pebble publish with store/icon-80.png and store/icon-144.png
```

The first run creates the store listing and asks for a name, description and category. In pebble-tool 5.1.2 the
listing goes public right away. Text for the listing:

> Add things to your Bring! shopping lists by voice with the Index 01 ring, and show them on your Pebble.
> Sign in with your Bring! account on the settings page. Items are matched with Bring!'s catalog, so they get
> their icon and section.
>
> Unofficial: not affiliated with, endorsed or sponsored by Bring! Labs AG. Bring! is a trademark of Bring!
> Labs AG. Uses Bring!'s web API, which can change at any time. Your password goes only to Bring! and isn't
> stored.

## Icon

`store/icon.svg` is the plugin's own icon: a shopping cart with a plus, deliberately unlike Bring!'s logo.
`store/icon-*.png` are renders of it (`rsvg-convert -w 144 -h 144 store/icon.svg -o store/icon-144.png`). The
Pebble app shows a plugin's icon only from its store listing. A sideloaded plugin shows the generic placeholder.
The settings page shows the same icon, inlined as SVG.

## Test

```sh
npm test                            # unit tests against a fake Bring! server (Node 18+)
```

`scripts/try.mjs` runs the plugin script against the real Bring! API with a stand-in Pebble runtime. Use it
to check a change without a phone. It writes to your real lists.

```sh
BRING_EMAIL=you@example.com BRING_PASSWORD='…' node scripts/try.mjs signin
node scripts/try.mjs match milk Müsli          # dry run: how names would be stored
node scripts/try.mjs add "2 l milk, eggs and bread"
node scripts/try.mjs action complete_item '{"name":"milk"}'
node scripts/try.mjs remove "Milch"            # delete a test item completely
node scripts/try.mjs signout
```

## Layout

- `package.json`: manifest. The `pebble.plugin` block declares sources, actions and their JSON Schemas.
  Index turns each action's `description` into the tool description, so word it for the model.
- `src/plugin/index.js`: the plugin (runs on the phone, a fresh session per request).
- `src/config.html`: settings page (sign in, default list, try it).
- `test/plugin.test.cjs`: tests. `scripts/try.mjs`: live harness.

## Bring! API notes

- Sign in: `POST rest/v2/bringauth` (form `email`, `password`). Renew: `POST rest/v2/bringauth/token`
  (`grant_type=refresh_token`).
- Lists: `GET rest/bringusers/{uuid}/lists`. List languages: `GET rest/bringusersettings/{uuid}`
  (`listArticleLanguage`).
- Items: `GET rest/v2/bringlists/{list}`. Changes: `PUT rest/v2/bringlists/{list}/items` with
  `{changes: [{itemId, spec, uuid, operation: TO_PURCHASE|TO_RECENTLY|REMOVE}], sender: ""}`.
- Catalog: `https://web.getbring.com/locale/articles.{locale}.json`, mapping each catalog key (Swiss German) to
  its local name.

Learned from [bring-api](https://github.com/miaucl/bring-api) (MIT), the library behind Home Assistant's Bring!
integration. No code from it is included.

## Legal

- **License:** [Apache License 2.0](LICENSE). Copyright 2026 Samuel Barabas. `wscript` is pebble-tool's MIT
  template. See [NOTICE](NOTICE).
- **No affiliation:** an independent project, not affiliated with, endorsed, sponsored or approved by Bring!
  Labs AG, Core Devices or the owners of the Pebble trademark.
- **Trademarks:** "Bring!" is a trademark of Bring! Labs AG. "Pebble" and "Index 01" are trademarks of their
  respective owners. They are used only to say what this works with. The repository contains no Bring! logos or
  artwork, and the license grants no trademark rights.
- **No warranty:** provided "as is", without warranty of any kind (Apache License, sections 7 and 8). Bring!
  Labs can change or block its API, or restrict accounts under its
  [terms of use](https://getbring.com/en/terms-of-use), at any time.
