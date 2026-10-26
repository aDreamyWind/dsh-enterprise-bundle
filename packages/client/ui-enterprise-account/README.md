---
description: "The enterprise account UI blocks the application until OIDC login succeeds and exposes a settings page for the browser-safe identity and sign-out action."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enterprise-account

English | [中文](README.zh.md)

## Summary

The enterprise account UI blocks the application until OIDC login succeeds and exposes a settings page for the browser-safe identity and sign-out action.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount this client plugin with the enterprise account controller. A non-dismissible application overlay observes the reconnect-safe account stream. One click starts login and opens the authorization URL in a separate browser page; the Host owns callback handling and publishes the signed-in state. Standard browsers reserve that page during the click and navigate it when the Host returns the URL; after login or renewed authorization succeeds, the UI closes the page it opened. Desktop asks Electron to open the URL in the system browser. A second open button appears only when browser popup policy blocked the reserved page; a manually opened browser tab still needs to be closed manually. The settings section displays only sanitized profile data and provides local-first sign-out.

`startTimeoutMs` sets how long the browser waits for the Host's sign-in response (15 seconds by default). If that request stalls, the reserved blank page closes and the UI reports that the Host may still be processing it. Keep one DSH tab open, refresh to check the account state, and retry. A response arriving after the deadline cannot reopen the old authorization page. When an account stream update arrives before a pending Remote response, the newer stream state remains visible.

All product copy is owned by the typed English and Chinese dictionaries. Tokens, authorization codes, PKCE material, and raw ID-token claims are absent from the Remote API and browser state.

The plugin mounts the generated enterprise account methods through the shared Remote transport before activating its UI registrations. It does not require changes to the official Remote assembly; unloading it withdraws those methods and registrations.

<a id="model-experience"></a>
## Model Experience

None, as the browser surface does not contribute model-visible input.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A browser that blocks the reserved page requires the visible fallback button.
- Organization branding remains a separate client-brand plugin.

<a id="dev-note"></a>
### Dev Note

The enterprise OIDC Agent Note owns the decision to compose this UI only in an enterprise profile.
