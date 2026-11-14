# Security policy

## Supported versions

Only the latest release is supported: the one in the
[Pebble app store](https://apps.repebble.com/5e2b3937f0814d3e944258a5), which is also the
[latest GitHub release](https://github.com/samuelb/pebble-plugin-shopping-list-for-bring/releases/latest).
Fixes ship as a new release. Older versions don't get them.

## Reporting a vulnerability

Report suspected vulnerabilities privately with GitHub's
[private vulnerability reporting](https://github.com/samuelb/pebble-plugin-shopping-list-for-bring/security/advisories/new),
not in a public issue. Include what's affected, how to reproduce it, the plugin version, and the impact you
expect.

This is a personal project, maintained on a best-effort basis, so there is no fixed response time. Reports are
taken seriously, and a fix comes before other work.

Report these elsewhere, because this project can't fix them:

- **Bring! itself** (its apps, its API, accounts and shared lists): Bring! Labs AG. This plugin is unofficial
  and not affiliated with them.
- **The Pebble app, the Index agent or the plugin runtime** (`Pebble.secureStorage`, domain permissions, the
  settings page's message channel): Core Devices.

## Threat model, in brief

- **Your Bring! password** is typed on the settings page and passed to the plugin through the Pebble app's
  message channel. It goes once to `api.getbring.com` over HTTPS to sign in, and it is never stored. Only the
  tokens Bring! returns are kept, in `Pebble.secureStorage`. Signing out deletes them.
- **The network:** the plugin talks only to `api.getbring.com` and `web.getbring.com`, over HTTPS. These are
  the two domains it declares, and the Pebble app enforces that list. The author runs no servers, and the plugin
  has no analytics. See [PRIVACY.md](PRIVACY.md).
- **The client key** (`X-BRING-API-KEY` in `src/plugin/index.js`) is the public key Bring!'s web app sends with
  every request. It names the app, not a user, and isn't a secret.
- **Untrusted text:** item and list names come from Bring!, and anyone on a shared list can write them. The
  settings page shows them as text, never as HTML. `read_list` hands them to the Index agent as text, so a
  shared list could carry a prompt-injection attempt. The plugin only offers shopping actions: add, check off
  and read. It can't delete lists or items.

## Existing gates

- **[CodeQL](https://codeql.github.com/)** scans the workflows and the JavaScript on every push and pull request
  to main, and every week ([.github/workflows/codeql.yml](.github/workflows/codeql.yml)).
- **Dependabot** raises alerts and opens pull requests for vulnerable dependencies, and proposes action updates
  weekly ([.github/dependabot.yml](.github/dependabot.yml)).
- **Secret scanning** looks for credentials in everything pushed, and push protection blocks known token
  formats.
- **Releases** come only from the [Release workflow](.github/workflows/release.yml). Its actions are pinned to
  commit SHAs, each job gets only the permissions it needs, and the store upload uses a short-lived GitHub
  OIDC token instead of a stored secret. The tests run before every build. GitHub releases are immutable once
  published. `v*` tags can't be moved or deleted, and main can't be force-pushed or deleted.

None of these replaces a report. Please still report anything they miss.
