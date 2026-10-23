---
description: "企业 bundle 为可发行的 Web 与 Desktop 企业版提供 Harness Admin OIDC 和模型网关，并替换官方登录与直连模型提供器。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-enterprise-bundle

[English](README.md) | 中文

## 概述

企业 bundle 为显式的 Web 与 Desktop 企业版提供 Harness Admin OIDC 强制登录，并把配置的模型编码路由到 Harness Admin 网关。普通上游 profile 保持不变。

## 目录

- [使用此 bundle](#use-this-bundle)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-bundle"></a>
## 使用此 bundle

请按[独立发行指南](../../../enterprise/README.zh.md)把外置 bundle 安装到 Web 或 Desktop profile。本检出目录的 `pnpm run start:enterprise-web` 辅助命令会初始化自定义 Web profile，无需修改官方模板注册表。该 patch 会禁用官方账号和直连模型路由，再挂载企业 OIDC、网关路由、模型选择策略、Remote 操作和强制登录 UI。

普通 `web` profile 和通用 Desktop 安装包继续使用上游组合。企业改动保留在增量包和显式 profile 层中，合并 upstream 更新时的冲突更少。

<a id="configuration"></a>
## 配置

请为 Desktop 和 Web 分别创建 Harness Admin 客户端。Desktop 登记为公开客户端，Token 认证方式使用 `none`，并登记不带端口的回调 `http://127.0.0.1/oauth/callback`；每次登录会绑定一个随机回环端口，并在授权请求和 Token 请求中发送同一个实际 URI。

Web 客户端登记为使用 `client_secret_basic` 的机密服务端应用。运维只需为 `enterprise-web` Host 配置一次，浏览器用户无需配置。本地开发可以使用 `http://127.0.0.1:3080/oauth/callback`。正式环境使用真实公网 HTTPS 地址，例如 `https://harness.company.example/oauth/callback`，并由反向代理把该路径原样转发到 Harness Host。配置的 Web 回调必须与登记值完全一致。

```dotenv
HARNESS_ADMIN_OIDC_ISSUER=http://localhost:8080
HARNESS_ADMIN_GATEWAY_BASE_URL=http://localhost:8080/v1
HARNESS_ADMIN_MODELS='[{"id":"Harness Admin model code"}]'

HARNESS_ADMIN_WEB_OIDC_CLIENT_ID='<Web confidential client id>'
HARNESS_ADMIN_WEB_OIDC_CLIENT_SECRET='<Host-only Web client secret>'
HARNESS_ADMIN_WEB_OIDC_REDIRECT_URI=http://127.0.0.1:3080/oauth/callback
```

`HARNESS_ADMIN_MODELS` 必须至少包含一项初始默认候选。登录后，Host 从 Admin 加载用户的可用模型；加载后若默认模型不可用，新 Session 会使用返回的第一个模型。静态条目只提供可选模型元数据，绝不会作为离线或错误时的后备列表。现有 Session 保留日志中的路由，直到用户选择另一个可用模型。

仓库中的 `pnpm run start:enterprise-web` 会在启动 profile 前为该本地配置启用回环 HTTP。`.env` 不能设置 `DSH_ENTERPRISE_ALLOW_LOOPBACK_HTTP` 安全开关。正式环境使用 HTTPS，不启用该开关。

构建 Desktop 企业版时，把 `apps/desktop/enterprise-desktop.example.json` 复制为私有发布配置，填写 issuer、Desktop 公开 client ID、`/v1` 网关地址和 Admin 模型编码，再在打包程序的 `.env.macos` 或 `.env.windows` 中用 `DSH_DESKTOP_ENTERPRISE_CONFIG` 指向该文件。校验后的公开设置会写入应用 manifest，并在启动时投影到私有 Host 子进程。该文件拒绝 `clientSecret`；安装后的应用不需要员工配置。

Desktop 安装包不包含 Web client secret。Web secret 只存在于 Web Host 环境。Access token 和轮换 refresh token 只保存在各自 Host 的凭据存储中，绝不进入浏览器状态。授权请求使用 `openid profile model.invoke offline_access`、PKCE S256、随机 `state` 与随机 `nonce`，且不发送 `audience` 参数。Discovery、Token、UserInfo 和 JWKS 地址都来自 `/.well-known/openid-configuration`；远端撤销为可选能力。

在源码仓库中，`pnpm --dir packages/credentials/enterprise-account-oidc run smoke:admin` 可对真实 Admin 执行可选交互式检查。设置 `HARNESS_ADMIN_SMOKE_MODE` 为 `desktop` 或 `web`，并提供 `HARNESS_ADMIN_SMOKE_ISSUER`、`HARNESS_ADMIN_SMOKE_CLIENT_ID`、`HARNESS_ADMIN_SMOKE_GATEWAY_BASE_URL` 和 `HARNESS_ADMIN_SMOKE_MODEL`；Web 模式还需要 `HARNESS_ADMIN_SMOKE_CLIENT_SECRET`，以及为本地测试登记的回环 `HARNESS_ADMIN_SMOKE_REDIRECT_URI`。脚本会检查 discovery、精确的 PKCE 授权参数、匹配的 Token 客户端认证、ID Token 与 UserInfo claims，并执行一次带 Bearer 认证的 `/v1/chat/completions` 请求，且不会打印令牌。

<a id="model-experience"></a>
## 模型体验

无，因为该 bundle 只改变身份验证与模型传输，不添加模型可见内容。

#### KV Cache 影响

模型请求前缀不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 模型选择器需要带鉴权的 `GET /v1/models`；目录请求失败时不显示静态后备模型。Admin 返回可用模型之前会保留配置的初始默认候选。
- 网关目前支持 `/v1/chat/completions`，不支持 `/v1/responses`。工具调用、多模态内容与流式工具调用取决于所选上游模型和提供商。
- 该 patch 生效时，随产品交付的模型路由都会使用 Harness Admin。后置的用户 patch 仍可添加其他适配器，因此要求只走网关的部署不能重新引入直连提供器路由。
- Harness Admin 负责模型调用与额度策略。企业 MCP 插件从员工目录装载已授权连接，在每次模型步骤前刷新，并通过 Admin 网关调用工具；Skill 分配仍未接入。每个 Web Host 只服务一位员工。
- 安装到官方 Desktop 应用时会保留原生品牌和欢迎页文案；内嵌配置和品牌安装包需要独立的分发构建。

<a id="dev-note"></a>
### 开发备注

企业 OIDC Agent Note 记录为何使用增量 profile 层，而不是改写整个 fork。
