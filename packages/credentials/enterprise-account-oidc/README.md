---
description: "The enterprise OIDC provider signs users in through a system browser, validates RS256 identity tokens, stores rotating grants, and refreshes gateway credentials under the credential-store lock."
kind: "package-reference"
---

# @deepseek-ai/dsh-enterprise-account-oidc

English | [中文](README.zh.md)

## Summary

The enterprise OIDC provider signs users in through a system browser, validates RS256 identity tokens, stores rotating grants, and refreshes gateway credentials under the credential-store lock.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the credentials, authorization, and Web Server services before this provider. The provider discovers the configured issuer, uses Authorization Code with PKCE S256, requires `state` and `nonce`, validates RS256 signatures through JWKS, and binds issuer, client audience, authorized party, expiry, issue time, nonce, and subject. The authorization request sends no `audience` parameter.

The stored grant is opaque to the credentials subsystem. Browser-facing state contains only the sanitized identity profile and attempt progress. Access and refresh tokens remain on the Host. Refresh-token rotation runs inside `credentials.modifyRecord`, preventing two Harness processes sharing one store from reusing the same rotating token.

<a id="configuration"></a>
## Configuration

`issuer`, `clientId`, `redirectUri`, and `gatewayOrigin` are required. Confidential Web clients use `client_secret_basic` by default or `client_secret_post`, and require a Host-only `clientSecret`; public Desktop clients use `none` and must omit it. `redirectMode` defaults to `fixed`, whose URI exactly matches its Harness Admin registration. `loopback-random-port` requires a portless `http://127.0.0.1` callback template, binds an operating-system-assigned port for each attempt, and sends that same actual URI in the authorization and token requests. `scopes` defaults to `openid profile model.invoke offline_access`. The browser-safe profile accepts `sub`, `name`, `preferred_username`, `email`, `org_id`, and `org_code`; access and refresh tokens never enter it. Request, attempt, refresh-margin, and clock-skew values are configurable. HTTP issuers are rejected unless `allowLoopbackHttp` is enabled and the issuer uses a loopback hostname.

<a id="model-experience"></a>
## Model Experience

None, as the provider changes authentication without adding model-visible content.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The provider does not route model requests by itself. The [enterprise gateway adapter](../../llm/llm-enterprise-gateway/README.md) consumes its Host-only tokens.
- Remote revocation is best effort after local sign-out and is skipped when discovery advertises no revocation endpoint.

<a id="dev-note"></a>
### Dev Note

The enterprise OIDC Agent Note owns the decision to keep this provider additive and outside the upstream default bundles.
