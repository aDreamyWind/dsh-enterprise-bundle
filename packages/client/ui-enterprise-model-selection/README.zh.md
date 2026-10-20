---
description: "通过刷新后的菜单选择企业模型，无需修改官方模型选择包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enterprise-model-selection

[English](README.md) | 中文

## 概述

通过输入区或 /model 命令选择已授权模型。打开任一选择器都会获取当前目录，并发打开共享同一个进行中的请求。刷新失败时隐藏旧选项，不继续提供陈旧的已授权列表。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过企业组合包替换普通模型选择界面；不要同时启用两者。Host 侧没有配置字段。客户端读取 enterpriseModels 目录，通过现有会话 RPC 提交选择，并使用共享界面基础组件。

| 字段 | 默认值 | 含义 |
|---|---|---|
| 插件配置 | 无 | 模型选项和保存的选择来自 Host |

输入区和命令共享一个目录及每个会话的选择状态。显式打开时先清除已完成加载的目录选项，再重新加载；请求失败时保留可重试状态。连接重置会清除旧 Host 代的数据，陈旧响应不能覆盖新数据。刷新不会重写已保存的选择。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[客户端实现](src/client/index.ts) 保留官方视觉设计并使用共享基础组件，但选择器实现是企业自行维护的副本。它提供独立的企业目录状态，并仅在普通选择器禁用时注册相同命令和输入区位置。

</details>

-----

<a id="model-experience"></a>
## Model Experience

### 模型选择控件

#### 模型看到什么

无直接影响；选择通过 `session.selectModel` 提交，由 Host 负责其对后续模型请求的影响。

#### token 影响

控件和目录刷新不增加提示词 token；所选模型的请求沿用常规用量统计。

#### KV Cache 影响

本界面不改变提示词前缀。选择其他路由仍可能降低后续请求在提供方侧的缓存复用。

## 已知限制和后续工作

<a id="known-limitations-and-deferred-work"></a>

本包的适用范围受以下限制。

- 官方选择器的改进不会自动更新此维护副本；每个受支持的 Harness 升级都需要对比和测试。
- 选择器要求已有普通会话；被寻址的 subagent 会话不提供独立模型选择。
- Host 和网关负责强制执行访问控制；隐藏选项不等于授权检查。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
