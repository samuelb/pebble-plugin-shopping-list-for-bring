# Privacy

Shopping List for Bring! is an unofficial plugin. It runs on your phone, inside the Pebble app. The author runs
no servers and receives no data from it.

## What it handles and where it goes

| Data | Where it goes | Where it's kept |
|---|---|---|
| Your Bring! email and password | Sent once to Bring! (`api.getbring.com`) to sign in | The password is never stored. The email is kept with the sign-in token. |
| Bring!'s sign-in tokens and account ids | Sent only to Bring!, with each request | On your phone, in the Pebble app's encrypted plugin storage (`Pebble.secureStorage`) |
| Your lists and items, and the items you add or check off | Between your phone and Bring! only | Cached list names and settings on your phone (`localStorage`) |
| Bring!'s item catalog (public, not personal) | Downloaded from `web.getbring.com` | Cached on your phone for up to a week |

The Pebble app lets the plugin talk only to the two domains it declares (`api.getbring.com` and
`web.getbring.com`). There is no analytics, tracking or advertising. When the Index agent or a watchface uses
the plugin, the items involved go to Bring! as described above.

## Removing your data

- **Sign out** on the settings page deletes the token and cached account data from your phone.
- **Uninstalling** the plugin deletes everything it stored.
- Your lists themselves live in your Bring! account. Bring! Labs' [privacy policy](https://www.getbring.com/en/privacy-policy)
  covers them.

Not affiliated with Bring! Labs AG. Bring! is a trademark of Bring! Labs AG.
