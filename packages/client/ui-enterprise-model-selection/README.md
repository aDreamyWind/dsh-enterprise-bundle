---
description: "Select enterprise models through refreshed menus without changing the upstream model-selection package."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enterprise-model-selection

English | [中文](README.zh.md)

## Summary

Select an authorized model from the composer or the /model command. Opening either selector fetches the current catalog while concurrent opens share an in-flight request. A failed refresh hides old choices instead of offering a stale authorized list.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the enterprise bundle to replace the ordinary model-selection UI; do not enable both together. The Host half has no configuration fields. The client reads the enterpriseModels directory, submits selections through the existing Session RPC, and uses shared UI primitives.

| Field | Default | Meaning |
|---|---|---|
| Plugin configuration | none | Model choices and saved selections come from the Host |

The composer and command share one catalog and per-session selection state. Explicit opens clear settled catalog choices before loading; a failed request leaves an actionable retry state. Connection resets clear the old Host generation, and outdated responses cannot overwrite its replacement. Refreshing does not rewrite the saved selection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [client implementation](src/client/index.ts) preserves the upstream visual design and uses shared primitives, but its selector implementation is an enterprise-owned copy. It provides separate enterprise directory state and registers the same command and composer positions only when the ordinary selector is disabled.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Model selection controls

#### What the model sees

None directly; selection submits through `session.selectModel`, and the Host owns its effect on subsequent model requests.

#### Token effect

Controls and catalog refreshes add no prompt tokens; selected model requests retain their ordinary accounting.

#### KV Cache effect

The prompt prefix is unchanged by this UI. Selecting another route can still reduce provider-side cache reuse for subsequent requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the package's supported scope.

- Upstream selector improvements do not update this maintained copy automatically; each supported Harness upgrade needs comparison and tests.
- The selector requires an existing ordinary session; addressed subagent sessions do not expose independent model selection.
- The Host and gateway enforce access; hiding an option is not an authorization check.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
