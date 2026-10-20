---
description: "选择已授权的企业默认模型，不持久化用户的临时回退选择。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-enterprise-default-model

[English](README.md) | 中文

## 概述

当部署配置中的候选模型不可用时，新 agent（智能体）可以使用首个已授权模型。已配置的候选模型及其推理强度保持不变。本包不会改变已有会话保存的选择。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过企业组合包替换普通默认模型提供方；不要同时挂载两个提供方。配置继承自[官方默认模型包](../agent-default-model/README.zh.md#use-this-package)。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 必填 | 为回退选择提供已授权模型目录的路由 |
| `model` | 必填 | 部署候选模型；未发布非空目录时保留该候选 |
| `reasoningEffort` | 无 | 候选模型的推理强度；临时使用其他模型时省略 |

网关按回退顺序发布已授权模型编码。当非空目录不包含已配置候选时，读取操作返回目录中的首个模型，不沿用候选的推理强度。可用目录为空或被清除时保留已配置候选；请求执行仍会检查授权。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[实现](src/index.ts) 继承官方默认模型服务，并单独提供企业模型可用性发布。可用性只保存在进程内，绝不调用继承的保存操作。用户显式保存仍遵循官方配置编辑器的行为。

</details>

-----

<a id="model-experience"></a>
## Model Experience

### 默认模型路由

#### 模型看到什么

无直接影响；入口和提供方适配器负责根据返回的 `ModelSelection` 构造模型请求。

#### token 影响

不增加提示词文本或工具；实际请求的 token 用量由所选模型决定。

#### KV Cache 影响

已有会话的前缀保持不变。只有后续解析部署默认值的 agent 才可能获得其他路由。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

本包的适用范围受以下限制。

- 本包提供默认选择策略，不负责授权检查；网关负责强制执行访问控制。
- 临时回退不会保存到配置，也不会重写已有会话的选择。
- 继承的服务 API 必须与所安装的 Harness 版本兼容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
