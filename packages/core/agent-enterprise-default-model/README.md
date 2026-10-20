---
description: "Choose an authorized enterprise default model without persisting a user's temporary fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-enterprise-default-model

English | [中文](README.zh.md)

## Summary

New agents can use the first authorized model when the deployment's configured candidate is unavailable. The configured candidate and its reasoning effort remain unchanged. This package does not change an existing session's saved selection.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the enterprise bundle to replace the ordinary default-model provider; do not mount both providers together. Configuration is inherited from the [upstream default-model package](../agent-default-model/README.md#use-this-package).

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | Route whose authorized model directory supplies the fallback |
| `model` | required | Deployment candidate, retained when no nonempty directory is published |
| `reasoningEffort` | absent | Candidate effort; omitted when another model is used temporarily |

The gateway publishes authorized ids in fallback order. A nonempty directory that excludes the configured candidate makes reads return its first model without the candidate's effort. Empty or cleared availability retains the configured candidate; request execution still checks authorization.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [implementation](src/index.ts) subclasses the upstream default-model service and exposes enterprise availability separately. Availability is process-local and never calls the inherited save operation. Explicit user saves retain upstream profile-editor behavior.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Default model routing

#### What the model sees

None directly; entry points and provider adapters own model requests created from the returned `ModelSelection`.

#### Token effect

No prompt text or tools are added; the chosen model determines its own request token usage.

#### KV Cache effect

Existing session prefixes remain unchanged. Only agents that subsequently resolve a deployment default can receive another route.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the package's supported scope.

- The package is a default-selection policy, not an authorization check; the gateway owns access enforcement.
- A temporary fallback is not saved to the profile and does not rewrite existing session selections.
- The inherited service API must remain compatible with the installed Harness version.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
