---
description: "Enterprise account consumers observe OIDC login state while Host gateway consumers resolve short-lived access tokens without exposing credentials to browser clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-enterprise-account

English | [中文](README.zh.md)

## Summary

Enterprise account consumers observe OIDC login state while Host gateway consumers resolve short-lived access tokens without exposing credentials to browser clients.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Service Definition separates browser-safe state from Host-only access-token resolution. `startSignIn` uses the provider's deployment-configured redirect URI, `watch` emits complete reconnectable snapshots, and `rejectAccessToken` retires only the token rejected by the gateway so a late response cannot invalidate a replacement grant.

Provider implementations serialize refresh-token rotation through the credential store. Consumers supply the actual request URL and required scopes on every resolution. `refreshAccessToken` recovers one gateway-rejected token without reusing a rotated refresh token; requests outside the configured gateway origin receive no token.

<a id="model-experience"></a>
## Model Experience

None, as identity state and credentials do not enter prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Service Definition does not assign models, quotas, skills, or MCP servers. Those policy decisions belong to the enterprise gateway and management service.

<a id="dev-note"></a>
### Dev Note

The enterprise OIDC Agent Note records package ownership and security requirements.
