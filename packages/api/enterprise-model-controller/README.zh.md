---
description: "读取企业模型目录及其按可用性调整的默认值，无需替换官方会话 API。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-enterprise-model-controller

[English](README.md) | 中文

## 概述

通过独立目录端点读取已授权企业模型选项及其当前默认值。首次响应会反映本次请求中发现的可用性。普通会话操作及其客户端保持不变。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

企业组合包将本控制器挂载在普通会话控制器旁，而不是替换后者。本包要求官方会话控制器和企业默认模型提供方，不增加配置字段，并通过 `enterpriseModels.modelCatalog` 为企业选择器提供目录。

| 字段 | 默认值 | 含义 |
|---|---|---|
| 插件配置 | 无 | 提供方发现和默认值来自注入的 Host 服务 |

端点保留普通目录中的提供方分组和发现失败信息。发现完成后，它重新读取部署默认值，使同一次请求期间发布的可用性立即生效。失败不会产生静态权限后备列表。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[控制器](src/index.ts) 在 enterpriseModels 命名空间下拥有一个经过身份验证的 Remote 方法。它调用官方目录，仅替换响应中的默认值。生成的 Remote 注册由企业客户端组合负责；官方会话控制器与共享 Remote 汇总均不需要增加企业导入。

</details>

-----

<a id="model-experience"></a>
## Model Experience

### 模型目录响应

#### 模型看到什么

无直接影响；`enterpriseModels.modelCatalog` 向客户端返回选项，不增加模型可见消息。

#### token 影响

目录响应不会向模型请求增加 token。

#### KV Cache 影响

无额外影响；agent（智能体）请求和提供方路由沿用已有缓存行为。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

本集成的适用范围受以下限制。

- 本包要求兼容的官方目录响应和默认模型 API。
- 网关负责强制执行模型权限；目录端点不授予访问权限。
- 端点不会修复已有会话中保存的不可用显式选择。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
