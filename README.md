# swamp-openwebui

A [swamp](https://swamp-club.com) extension for
[OpenWebUI](https://github.com/open-webui/open-webui).

| Extension | Type | What it does |
| --- | --- | --- |
| [`@sntxrr/openwebui`](extensions/models/README.md) | model | `sync` records what an instance reports about itself; `drift` reports how far its version has fallen behind upstream releases |

Read-only and credential-free — both endpoints it uses answer before login.
See [the extension README](extensions/models/README.md) for methods,
configuration, and the three behaviours worth knowing before relying on it.

## Why this exists

An OpenWebUI container left on the floating `:main` tag looks permanently up to
date. It isn't: the tag is only re-resolved when something re-pulls it, so an
instance started once and left alone freezes at whatever version it happened to
get. The instance this was built against sat on 0.8.12 while eleven releases
went by.

Nothing surfaces that. The UI does not say "you are behind", and a container
healthcheck goes green either way — `/health` reports on the web process, not
on how old it is.

`drift` is the thing that says it out loud:

```
runningVersion    0.8.12
latestVersion     0.11.0
status            behind
releasesBehind    11
missedReleases    v0.11.0, v0.10.2, v0.10.1, v0.10.0, v0.9.6, ...
truncated         false
```

It reports; it does not act. Pair it with whatever pins your image — the point
is knowing when that pin needs moving.

## Install

```bash
swamp extension pull @sntxrr/openwebui
swamp model create @sntxrr/openwebui/instance openwebui \
  --global-arg baseUrl=http://localhost:3000
swamp model @sntxrr/openwebui/instance method run drift openwebui
```

## Where the implementation lives

This repo is **extension source only** — the reusable artifact published to
swamp club. It deliberately contains no model instances, no workflows and no
operator state.

The running implementation lives in a separate repo (`~/git/swamp-homelab`)
which mounts this one upstream:

```bash
swamp extension source add ~/git/swamp-extensions/openwebui
```

That repo holds the `openwebui` model instance, the `openwebui-drift-watch`
workflow and the datastore config — all of which reference instance names and a
baseUrl that mean nothing to anyone else, and so have no business in a package
other people install.

## Development

```bash
~/.swamp/deno/deno check extensions/models/openwebui_instance.ts
~/.swamp/deno/deno test --allow-net extensions/models/openwebui_instance_test.ts
swamp extension quality extensions/models/manifest.yaml --json
```

## License

MIT
