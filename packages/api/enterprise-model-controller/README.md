---
description: "Read an enterprise model directory with its availability-adjusted default without replacing the upstream Session API."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-enterprise-model-controller

English | [中文](README.zh.md)

## Summary

Read authorized enterprise model choices and their current default through a separate directory endpoint. The first response reflects availability discovered during that request. Ordinary Session operations and their client remain unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The enterprise bundle mounts this controller beside the ordinary Session controller, not in its place. It requires the upstream Session controller and the enterprise default-model provider, adds no configuration fields, and serves the enterprise selector through `enterpriseModels.modelCatalog`.

| Field | Default | Meaning |
|---|---|---|
| Plugin configuration | none | Provider discovery and defaults come from the injected Host services |

The endpoint retains provider groups and discovery failures from the ordinary catalog. After discovery finishes, it reads the deployment default again so availability published during the same request is reflected immediately. A failure does not produce a static permission fallback.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [controller](src/index.ts) owns one authenticated Remote method under the enterpriseModels namespace. It calls the upstream catalog and replaces only the returned default. Its generated Remote registration belongs to the enterprise client composition; neither the upstream Session controller nor the shared Remote aggregate needs an enterprise import.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Model directory responses

#### What the model sees

None directly; `enterpriseModels.modelCatalog` returns choices to clients and adds no model-visible messages.

#### Token effect

Directory responses do not add tokens to model requests.

#### KV Cache effect

No additional effect; agent requests and provider routing retain their existing cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the supported integration.

- The package requires a compatible upstream catalog response and default-model API.
- The gateway enforces model permissions; the directory endpoint does not grant access.
- The endpoint does not repair an unavailable explicit selection saved in an existing session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
