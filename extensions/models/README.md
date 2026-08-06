# @sntxrr/openwebui

Read a running [OpenWebUI](https://github.com/open-webui/open-webui) instance
and report how far its version has drifted behind upstream.

One model type, `@sntxrr/openwebui/instance`, with two methods. **Both are
read-only** — nothing in this extension writes to OpenWebUI, changes its
configuration, or triggers an update. It tells you an update is available; the
updating is yours to do.

## What it does not do

Stated plainly, because the name invites the assumption: it does not upgrade
the instance, edit its settings, manage users or model connections, or touch
the container. It reads two endpoints and compares two version numbers.

## Why it needs no credentials

Both endpoints it uses — OpenWebUI's `/api/config` and the GitHub releases API
— answer without authentication.

That is a deliberate scope boundary. Anything that manages users, models or
settings needs an API key, and an instance can have API keys switched off
entirely (`enable_api_keys: false`), which no credential works around. Rather
than require a key it may be impossible to issue, this model stays on the side
of the API that always answers and has `sync` report the flag, so you can see
whether deeper automation is even possible before attempting it.

## Methods

### `sync`

Records what the instance reports about itself. One HTTP GET to `/api/config`.

```bash
swamp model @sntxrr/openwebui/instance method run sync openwebui
```

Writes one `instance` resource named `instance-<host>-<port>`:

| Field | Meaning |
| --- | --- |
| `url` | Base URL this reading came from |
| `version` | Version the instance reports |
| `name` | Instance display name |
| `authEnabled` | Whether a login is required at all |
| `apiKeysEnabled` | Whether API keys can be issued — false blocks all token-authenticated automation |
| `signupEnabled` | Whether new accounts can self-register |
| `websocketEnabled` | Whether chat streams over a WebSocket |
| `checkedAt` | When this reading was taken |

`websocketEnabled` is worth knowing before putting a forward-auth proxy in
front of the instance, since chat streams over that socket.

When `apiKeysEnabled` is false, `sync` also logs a warning — it is the single
flag that decides whether any token-authenticated integration is possible.

### `drift`

Compares the running version against the repo's published GitHub releases.
Reads `/api/config`, then one page of up to 100 releases.

```bash
swamp model @sntxrr/openwebui/instance method run drift openwebui
```

Writes one `drift` resource named `drift-<host>-<port>`:

| Field | Meaning |
| --- | --- |
| `behind` | The single field to alert on |
| `status` | `current`, `behind`, or `ahead` |
| `releasesBehind` | How many published releases are newer |
| `missedReleases` | Which ones, newest first — the changelog you have not read |
| `runningVersion` | What the instance reports |
| `latestVersion` | Newest upstream release, normalised (no leading `v`) |
| `latestPublishedAt` | When that release was published |
| `url`, `checkedAt` | Which instance, and when |

`ahead` is a normal state, not an error: a `:main` build reports a version
newer than any published tag.

## Configuration

| Global arg | Required | Default | Notes |
| --- | --- | --- | --- |
| `baseUrl` | yes | — | e.g. `http://localhost:3000` |
| `githubRepo` | no | `open-webui/open-webui` | Override only for a fork |
| `githubToken` | no | — | Raises the GitHub rate limit from 60/hr to 5000/hr. Needs no scopes for a public repo. Marked sensitive; supply via `vault.get()`. |
| `includePrereleases` | no | `false` | Being "behind" an rc is not actionable |
| `timeoutMs` | no | `10000` | Applied to each HTTP call |

```bash
swamp model create @sntxrr/openwebui/instance openwebui \
  --global-arg baseUrl=http://localhost:3000
```

## Three behaviours worth knowing

**Versions are compared numerically, never as strings.** OpenWebUI's versions
break lexical ordering in both directions — `"0.8.12" > "0.11.0"` and
`"0.8.12" < "0.8.9"` are both true as strings and both wrong. A string compare
reports an instance eleven releases behind as up to date. Tested against the
real upstream release list.

**An exhausted GitHub rate limit is an error, not an empty release list.**
Unauthenticated GitHub allows 60 requests/hour/IP and answers 403. Folding that
into "no releases found" would report every instance as current at exactly the
moment the check stopped working. A missing repo (404) is likewise raised as
itself.

**An unparseable running version throws.** Reporting `current` because the
comparison could not be made is the failure this model exists to prevent. The
same applies when no release tag parses at all.

## Development

```bash
~/.swamp/deno/deno check extensions/models/openwebui_instance.ts
~/.swamp/deno/deno test --allow-net extensions/models/openwebui_instance_test.ts
```

25 tests, covering the version-ordering traps, the drift arithmetic against the
real release list, resource-name collisions, and both error paths.
`writeResource` is stubbed with the model's own declared zod schema rather than
a recorder, so a resource that stops matching its schema fails the test instead
of passing silently — verified by mutation, not assumed.

## License

MIT
