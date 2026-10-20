---
description: "Enterprise login screens use authenticated Remote commands and a reconnect-safe state stream without exposing access tokens, refresh tokens, authorization codes, or PKCE material."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-enterprise-account-controller

English | [中文](README.zh.md)

## Summary

Enterprise login screens use authenticated Remote commands and a reconnect-safe state stream without exposing access tokens, refresh tokens, authorization codes, or PKCE material.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The `enterpriseAccount` namespace exposes `getState`, `startSignIn`, `cancelSignIn`, `signOut`, and `watch`. `watch` emits an initial complete state and later complete states. Ending a subscription stops observation without cancelling the browser attempt. Cancellation names an attempt ID so a stale page cannot cancel a newer login.

The controller deliberately has no token-resolution method. Gateway adapters consume the Host-only Service Definition directly.

The enterprise account UI mounts this package's generated `enterpriseAccount` methods through the shared Remote transport; the official Remote assembly requires no enterprise registration.

For Desktop, `desktop: { usageUrl, topUpUrl, allowLoopbackHttp? }` also provides the existing native `account` RPC methods using enterprise login state. Omit `desktop` on Web. The destinations must use HTTPS without credentials, query strings, or fragments; explicit loopback HTTP permission is available for local development. The native account implementation inherits the official method declarations without registering duplicate Remote endpoints.

<a id="model-experience"></a>
## Model Experience

None, as the controller exposes identity state only to the authenticated application client.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The stream recovers current state after reconnect but does not resume a browser attempt after Host process exit.

<a id="dev-note"></a>
### Dev Note

The enterprise OIDC Agent Note records why token-bearing operations remain outside Remote.
