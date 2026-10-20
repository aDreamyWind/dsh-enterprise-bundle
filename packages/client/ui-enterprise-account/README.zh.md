---
description: "企业账号 UI 会在 OIDC 登录成功前阻止使用应用，并提供展示浏览器安全身份信息和退出操作的设置页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enterprise-account

[English](README.md) | 中文

## 概述

企业账号 UI 会在 OIDC 登录成功前阻止使用应用，并提供展示浏览器安全身份信息和退出操作的设置页。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

请将此客户端插件与企业账号控制器一起挂载。不可关闭的应用级覆盖层观察可重连账号状态流。一次点击会发起登录，并在独立浏览器页面打开授权 URL；Host 负责处理回调并发布登录状态。普通浏览器会在点击时预留该页面，并在 Host 返回 URL 后导航；Desktop 则要求 Electron 用系统浏览器打开 URL。只有浏览器弹窗策略拦截预留页面时，界面才会显示第二个打开按钮。设置页只显示脱敏资料，并提供本地优先的退出操作。

所有产品文案都由类型化的中英文字典管理。Token、授权码、PKCE 数据和原始 ID Token claim 不会进入 Remote API 或浏览器状态。

本插件先通过共享 Remote 传输挂载生成的企业账号方法，再激活界面注册。它不要求修改官方 Remote 汇总；卸载插件会撤回这些方法和界面注册。

<a id="model-experience"></a>
## 模型体验

无，因为浏览器界面不贡献模型可见输入。

#### KV Cache 影响

模型请求前缀不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 浏览器拦截预留页面时，需要使用界面显示的备用按钮。
- 企业品牌替换仍由独立客户端品牌插件负责。

<a id="dev-note"></a>
### 开发备注

企业 OIDC Agent Note 负责记录该 UI 只在企业 profile 中组合的决策。
