---
description: "企业账号消费者观察 OIDC 登录状态，Host 网关消费者解析短期访问令牌，且凭据不会暴露给浏览器客户端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-enterprise-account

[English](README.md) | 中文

## 概述

企业账号消费者观察 OIDC 登录状态，Host 网关消费者解析短期访问令牌，且凭据不会暴露给浏览器客户端。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

该服务定义将浏览器安全状态与仅限 Host 的访问令牌解析分离。`startSignIn` 使用提供器的部署配置回调地址，`watch` 发送可重连的完整快照，`rejectAccessToken` 只停用网关拒绝的令牌，因此延迟响应不会使替换后的授权失效。

提供器实现通过凭据存储串行化刷新令牌轮换。消费者每次解析都提供实际请求 URL 和所需 scope。`refreshAccessToken` 可以恢复一次被网关拒绝的令牌，且不会重复使用已经轮换的 refresh token；发往已配置网关源之外的请求不会获得令牌。

<a id="model-experience"></a>
## 模型体验

无，因为身份状态和凭据不会进入提示词、Session 日志或工具结果。

#### KV Cache 影响

模型请求前缀不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 该服务定义不分配模型、额度、Skill 或 MCP Server。这些策略决策属于企业网关和管理服务。

<a id="dev-note"></a>
### 开发备注

企业 OIDC Agent Note 记录包所有权和安全要求。
