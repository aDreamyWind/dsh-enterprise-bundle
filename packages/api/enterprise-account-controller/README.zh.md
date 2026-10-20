---
description: "企业登录界面通过已认证 Remote 命令和可重连状态流工作，同时不暴露访问令牌、刷新令牌、授权码或 PKCE 数据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-enterprise-account-controller

[English](README.md) | 中文

## 概述

企业登录界面通过已认证 Remote 命令和可重连状态流工作，同时不暴露访问令牌、刷新令牌、授权码或 PKCE 数据。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

`enterpriseAccount` 命名空间提供 `getState`、`startSignIn`、`cancelSignIn`、`signOut` 和 `watch`。`watch` 先发送一份完整初始状态，再发送后续完整状态。结束订阅只停止观察，不会取消浏览器登录尝试。取消操作携带尝试 ID，因此旧页面不能取消较新的登录。

控制器有意不提供令牌解析方法。网关适配器直接消费仅限 Host 的服务定义。

企业账号界面通过共享 Remote 传输挂载本包生成的 `enterpriseAccount` 方法；官方 Remote 汇总无需注册企业功能。

桌面端配置 `desktop: { usageUrl, topUpUrl, allowLoopbackHttp? }` 后，还会使用企业登录状态提供现有原生 `account` RPC 方法。网页端省略 `desktop`。目标地址必须使用 HTTPS，且不含凭据、查询串或片段；本地开发可显式允许回环 HTTP。原生账号实现继承官方方法声明，不重复注册 Remote 端点。

<a id="model-experience"></a>
## 模型体验

无，因为控制器只向已认证的应用客户端公开身份状态。

#### KV Cache 影响

模型请求前缀不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 状态流可在重连后恢复当前状态，但 Host 进程退出后不会恢复浏览器登录尝试。

<a id="dev-note"></a>
### 开发备注

企业 OIDC Agent Note 记录令牌相关操作为何保留在 Remote 之外。
