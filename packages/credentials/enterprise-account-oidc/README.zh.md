---
description: "企业 OIDC 提供器通过系统浏览器登录用户、校验 RS256 身份令牌、存储轮换授权，并在凭据存储锁内刷新网关凭据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-enterprise-account-oidc

[English](README.md) | 中文

## 概述

企业 OIDC 提供器通过系统浏览器登录用户、校验 RS256 身份令牌、存储轮换授权，并在凭据存储锁内刷新网关凭据。

## 目录

- [使用此包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

请先挂载凭据、授权和 Web Server 服务，再挂载此提供器。提供器发现已配置 issuer，使用 Authorization Code + PKCE S256，要求 `state` 与 `nonce`，通过 JWKS 校验 RS256 签名，并绑定 issuer、client audience、必要时的 authorized party、过期时间、签发时间、nonce 和 subject。授权请求不会发送 `audience` 参数。

存储的授权对凭据子系统保持不透明。面向浏览器的状态只包含脱敏身份资料和尝试进度。访问令牌和刷新令牌始终留在 Host。刷新令牌轮换在 `credentials.modifyRecord` 内执行，防止共享同一存储的两个 Harness 进程重复使用同一个轮换令牌。

<a id="configuration"></a>
## 配置

`issuer`、`clientId`、`redirectUri` 和 `gatewayOrigin` 为必填项。机密 Web 客户端默认使用 `client_secret_basic`，也可以使用 `client_secret_post`，并要求仅限 Host 的 `clientSecret`；公开 Desktop 客户端使用 `none`，且必须省略该字段。`redirectMode` 默认为 `fixed`，其 URI 必须与 Harness Admin 登记值完全一致。`loopback-random-port` 要求一个不带端口的 `http://127.0.0.1` 回调模板，每次尝试绑定操作系统分配的端口，并在授权请求和 Token 请求中发送同一个实际 URI。`scopes` 默认是 `openid profile model.invoke offline_access`。浏览器安全资料接受 `sub`、`name`、`preferred_username`、`email`、`org_id` 和 `org_code`；access token 和 refresh token 绝不会进入其中。请求时限、登录尝试时限、提前刷新时长和时钟偏差均可配置。除非启用 `allowLoopbackHttp` 且 issuer 使用回环主机名，否则 HTTP issuer 会被拒绝。

<a id="model-experience"></a>
## 模型体验

无，因为提供器只改变身份验证，不添加任何模型可见内容。

#### KV Cache 影响

模型请求前缀不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 提供器本身不路由模型请求。[企业网关适配器](../../llm/llm-enterprise-gateway/README.zh.md)会消费其仅限 Host 的令牌。
- 本地退出后只会尽力执行远端撤销；如果发现文档没有公布撤销端点，则跳过远端撤销。

<a id="dev-note"></a>
### 开发备注

企业 OIDC Agent Note 负责记录该提供器保持增量接入且不进入上游默认 bundle 的决策。
