# Harness enterprise plugin distribution tools

English | [中文](README.zh.md)

## Usage

An external bundle supplies enterprise login, gateway routing, model discovery, default-model policy, model selection, and employee MCP tool connections. Enterprise login and gateway routing do not rewrite upstream default-model services, Session APIs, model selectors, or profile templates. Immediate enterprise skill menu updates require a Harness revision whose Host forwards `skills/change` and whose skill UI clears its cache on that event. `packages.json` lists the plugin source directories.

The plugin targets Harness `0.2.2-alpha.2`, as declared in `compatibility.json`.

### Build and verify an archive

Run `pnpm install` in a compatible official Harness checkout, then run from this plugin repository:

```sh
node enterprise/build.mjs --harness /absolute/path/to/official-harness --ref HEAD --verify
```

`--verify` builds artifacts, checks test types, and runs the focused enterprise tests inside a temporary SDK copy. The build borrows installed third-party dependencies from the official checkout and resolves every workspace package inside the copy. The command prints the archive path; adjacent `compatibility.json` records the Harness version. One archive contains the enterprise bundle and all enterprise child plugins. Harness continues to provide its official runtime libraries.

The archive includes a `LICENSE` for each package and `THIRD_PARTY_LICENSES` for inlined third-party code. The release omits source maps and compiler caches. Run `npm run test:pack` to check the archive layout and that build paths stay out of shipped files.

### Install into official Web

Install and build a compatible official Harness first, then run inside its checkout; replace the archive path with the actual path printed by packing.

```sh
pnpm dsh --profile enterprise-web --from-default-profile web --dump-config
pnpm dsh plugin --profile enterprise-web add /absolute/path/to/enterprise-bundle.tgz
```

Use the first command only to create a new dedicated profile: it replaces an existing profile of that name, so do not repeat it when upgrading plugins. The second command appends the enterprise bundle; do not omit the initial Web-template copy, because a new custom profile otherwise contains only base services and no Web application. Fill the enterprise fields from `.env.example` into `.env` in that official working directory; the client secret belongs only to the Web Host. For local HTTP development, run:

```sh
DSH_ENTERPRISE_ALLOW_LOOPBACK_HTTP=true pnpm dsh --profile enterprise-web
```

Do not enable the loopback HTTP switch in HTTPS production. `pnpm dsh web` remains ordinary mode. Do not run two instances on the same Host port.

### Install into official Desktop

Start the official desktop application once to initialize its profile, then quit completely. Use the `dsh` supplied by that desktop installation, not an ordinary npm or source CLI:

```sh
dsh plugin --profile desktop add /absolute/path/to/enterprise-bundle.tgz
```

Replace the public addresses, Desktop client ID, and model code in [desktop.patch.example.yml](desktop.patch.example.yml), then append its rows to the desktop profile's `cordis.patch.yml`, preserving existing configuration; never distribute the Web client secret. This example supplies the default model, OIDC, gateway, and native account compatibility settings without employee environment variables. Desktop uses a public client, PKCE, and a random loopback port, while the enterprise plugin supplies account compatibility for native windows.

A plugin cannot change the signed official application's icon, application name, update source, or native welcome copy.

## Build detached sources

Building requires a compatible official source checkout where `pnpm install` has completed, plus Node, pnpm, npm, Git, and tar:

```sh
node enterprise/build.mjs --harness /absolute/path/to/official-harness --ref HEAD
```

The tool creates a temporary SDK copy from the selected Git ref, assembles plugins and compiler configuration only inside that copy, then emits one `.tgz`. It does not overwrite the existing official checkout or older releases. It rejects a Harness version different from `compatibility.json`; port and verify the plugins before updating that record, rather than merely changing a version to bypass validation.

The gateway borrows compatible upstream configuration and authentication helpers at build time; artifacts do not load official TypeScript sources at runtime. The official Session client remains unchanged. The enterprise model selector has an owned copy: its behavior is retained, but upstream changes to that component require separate evaluation and are not merged automatically.

## Updates and retained data

Back up the plugin source repository, releases, Host configuration, and Harness user data first. Validate login, token rotation, model discovery, model switching, and chat with a separate test profile before replacing production Harness. Do not delete Harness home, credentials, or Session directories to upgrade.
