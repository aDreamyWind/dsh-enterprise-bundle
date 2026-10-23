---
description: "The enterprise bundle powers shipped Web and Desktop enterprise editions that replace official login and direct model providers with Harness Admin OIDC and gateway routing."
kind: "package-bundle"
---

# @deepseek-ai/dsh-enterprise-bundle

English | [中文](README.zh.md)

## Summary

The enterprise bundle powers explicit Web and Desktop enterprise editions that require Harness Admin OIDC login and route configured model codes through the Harness Admin gateway. The ordinary upstream profiles remain unchanged.

## Table of Contents

- [Use this bundle](#use-this-bundle)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-bundle"></a>
## Use this bundle

Install the external bundle into a Web or Desktop profile using the [standalone distribution guide](../../../enterprise/README.md). This checkout's `pnpm run start:enterprise-web` helper initializes its custom Web profile without changing the official template registry. The patch disables official-account and direct-provider model routes, then mounts enterprise OIDC, gateway routing, model-selection policy, Remote operations, and the mandatory login UI.

The ordinary `web` profile and generic Desktop package retain the upstream composition. Enterprise changes remain in additive packages and an explicit profile layer, reducing conflicts when merging upstream updates.

<a id="configuration"></a>
## Configuration

Create separate Harness Admin clients for Desktop and Web. Register Desktop as a public client with token authentication `none` and the portless callback `http://127.0.0.1/oauth/callback`; each login binds a random loopback port and sends that actual URI in both the authorization and token requests.

Register Web as a confidential server-side application using `client_secret_basic`. Operations configures the `enterprise-web` Host once; browser users configure nothing. Local development can use `http://127.0.0.1:3080/oauth/callback`. Production uses the actual public HTTPS URL, such as `https://harness.company.example/oauth/callback`, and the reverse proxy forwards that path unchanged to the Harness Host. The configured Web callback must exactly match its registration.

```dotenv
HARNESS_ADMIN_OIDC_ISSUER=http://localhost:8080
HARNESS_ADMIN_GATEWAY_BASE_URL=http://localhost:8080/v1
HARNESS_ADMIN_MODELS='[{"id":"Harness Admin model code"}]'

HARNESS_ADMIN_WEB_OIDC_CLIENT_ID='<Web confidential client id>'
HARNESS_ADMIN_WEB_OIDC_CLIENT_SECRET='<Host-only Web client secret>'
HARNESS_ADMIN_WEB_OIDC_REDIRECT_URI=http://127.0.0.1:3080/oauth/callback
```

`HARNESS_ADMIN_MODELS` must contain at least one initial default candidate. After login, the Host loads the user's available models from Admin; once loaded, an unavailable default uses the first returned model for new Sessions. Static entries only provide optional model metadata, never an offline or error fallback list. An existing Session retains its logged route until the user selects another available model.

The repository's `pnpm run start:enterprise-web` command enables loopback HTTP for this local configuration before it starts the profile. The `.env` file cannot set the `DSH_ENTERPRISE_ALLOW_LOOPBACK_HTTP` security switch. Production deployments use HTTPS and do not enable it.

For an enterprise Desktop release, copy `apps/desktop/enterprise-desktop.example.json` to a private release file, fill its issuer, public Desktop client ID, `/v1` gateway URL, and Admin model codes, then set `DSH_DESKTOP_ENTERPRISE_CONFIG` in the packager's `.env.macos` or `.env.windows` to that file. The validated public settings are embedded in the application manifest and projected into the private Host child on launch. The file rejects `clientSecret`; the installed application needs no employee configuration.

The Desktop package contains no Web client secret. The Web secret exists only in the Web Host environment. Access and rotating refresh tokens stay in each Host's credential store and never enter browser state. Authorization requests use `openid profile model.invoke offline_access`, PKCE S256, random `state`, and random `nonce`; they send no `audience` parameter. Discovery, token, UserInfo, and JWKS locations come from `/.well-known/openid-configuration`; remote revocation is optional.

From a source checkout, `pnpm --dir packages/credentials/enterprise-account-oidc run smoke:admin` performs an optional interactive check against a live Admin. Set `HARNESS_ADMIN_SMOKE_MODE` to `desktop` or `web`, plus `HARNESS_ADMIN_SMOKE_ISSUER`, `HARNESS_ADMIN_SMOKE_CLIENT_ID`, `HARNESS_ADMIN_SMOKE_GATEWAY_BASE_URL`, and `HARNESS_ADMIN_SMOKE_MODEL`; Web mode also requires `HARNESS_ADMIN_SMOKE_CLIENT_SECRET` and a loopback `HARNESS_ADMIN_SMOKE_REDIRECT_URI` registered for local testing. The script verifies discovery, exact PKCE authorization parameters, matching token-client authentication, ID token and UserInfo claims, and one bearer-authenticated `/v1/chat/completions` request without printing tokens.

<a id="model-experience"></a>
## Model Experience

None, as the bundle changes authentication and model transport without adding model-visible content.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The model selector requires authenticated `GET /v1/models`; a failed directory request shows no static fallback models. The configured initial default candidate is retained until Admin returns an available model.
- The gateway currently supports `/v1/chat/completions`, not `/v1/responses`. Tool calls, multimodal content, and streaming tool calls depend on the selected upstream model and provider.
- The shipped model routes all use Harness Admin while this patch is active. A later user patch can still add another adapter, so deployment owners must not reintroduce direct-provider routes when gateway-only routing is required.
- Harness Admin enforces model invocation and quota policy. The enterprise MCP plugin mounts the signed-in employee’s authorized connections and refreshes them before each model step; Skill assignment remains separate. Each Web Host serves one employee.
- Installing into an official Desktop application retains its native branding and welcome copy; embedded configuration and branded installers require a separate distribution build.

<a id="dev-note"></a>
### Dev Note

The enterprise OIDC Agent Note records why the integration is an additive profile layer instead of a fork-wide rewrite.
