# Harness 企业插件发行工具

[English](README.md) | 中文

## 使用方式

企业登录、模型网关、动态模型目录、默认模型策略、模型选择器和员工 MCP 工具连接通过外置 bundle 加载。企业登录与模型网关不需要改写官方默认模型、Session API、模型选择器或 profile 模板。企业 Skills 的即时菜单刷新要求 Host 转发 `skills/change`，且官方技能 UI 在收到该事件时清理缓存；集成分支提供这项通用修复。`packages.json` 列出插件拥有的源文件目录。

当前插件面向 `compatibility.json` 声明的 Harness `0.2.2-alpha.2`。独立仓库使用下文的构建命令生成发行包；`pnpm run start:enterprise-web` 只属于旧 fork。

### 生成并验证发行包

先在兼容的官方 Harness 检出目录运行 `pnpm install`，然后在本插件仓库执行：

```sh
node enterprise/build.mjs --harness /absolute/path/to/official-harness --ref HEAD --verify
```

`--verify` 在临时 SDK 副本中构建产物、检查测试类型并运行企业插件的定向测试。构建只借用官方目录中已安装的第三方依赖，所有 workspace 包解析到临时副本。命令打印 `.tgz` 的绝对路径；同目录的 `compatibility.json` 记录对应 Harness 版本。一个归档包含企业 bundle 和全部企业子插件，官方运行库仍由 Harness 提供。

### 安装到官方 Web

先安装并构建兼容版本的官方 Harness，然后在其目录中执行；将归档路径替换为打包命令输出的实际路径。

```sh
pnpm dsh --profile enterprise-web --from-default-profile web --dump-config
pnpm dsh plugin --profile enterprise-web add /absolute/path/to/enterprise-bundle.tgz
```

第一条命令只用于首次创建新的专用 profile：它会重建已有同名 profile，升级插件时不要重复执行。第二条命令追加企业 bundle；不能省略首次复制 Web 模板的步骤，否则自定义 profile 默认只有基础服务，没有网页应用。将 `.env.example` 中的企业配置填写到该官方工作目录的 `.env`，客户端密钥只允许保存在 Web Host。员工 MCP 需要为 OIDC 客户端允许 `mcp.invoke`，已有员工需在账号设置中重新授权；每个 Web Host 仅服务一位员工。本地 HTTP 调试时执行：

```sh
DSH_ENTERPRISE_ALLOW_LOOPBACK_HTTP=true pnpm dsh --profile enterprise-web
```

正式 HTTPS 环境不设置这个回环 HTTP 开关。`pnpm dsh web` 仍是普通模式。不要同时运行两个使用同一 Host 端口的实例。

### 安装到官方桌面端

先启动官方桌面应用一次以初始化 profile，然后完全退出。使用该桌面安装包随附的 `dsh`，而不是普通 npm/源码 CLI：

```sh
dsh plugin --profile desktop add /absolute/path/to/enterprise-bundle.tgz
```

请修改 [desktop.patch.example.yml](desktop.patch.example.yml) 中的公开地址、Desktop 客户端 ID 和模型编码，将这些行追加到桌面 profile 的 `cordis.patch.yml`，保留已有配置；不要分发 Web 客户端密钥。这个示例同时覆盖默认模型、OIDC、网关与原生账号兼容配置，不依赖员工设置环境变量。桌面使用公开客户端、PKCE 和随机回环端口，企业插件为原生窗口提供账号兼容接口。

插件不能修改官方签名应用的图标、应用名、更新源和原生欢迎页文案。当前分支的内嵌配置与品牌打包能力属于额外的桌面分发层，不包含在插件安装承诺中；需要这类安装包时仍保留相应打包源码与签名配置。

## 独立源码构建

导出目录不包含官方源码，也不需要对官方检出目录应用补丁。构建依赖一个已运行过 `pnpm install` 的兼容官方源码检出目录，以及 Node、pnpm、npm、Git 和 tar：

```sh
node enterprise/build.mjs --harness /absolute/path/to/official-harness --ref HEAD
```

构建工具从指定 Git ref 创建临时 SDK 副本，只在副本中装配插件和编译配置，最后输出单一 `.tgz`。已有官方检出目录和旧发行包不会被覆盖。工具拒绝与 `compatibility.json` 不同的 Harness 版本；升级时先适配并验证插件，再更新该记录，不要仅修改版本号绕过检查。

网关在构建时借用兼容版本的官方配置与认证辅助实现，产物不依赖运行时加载官方 TypeScript 源文件。官方 Session 客户端保持原样。企业模型选择器有自有维护副本：界面行为保留，但官方对该组件的更新需要单独评估，不会自动合入。

## 更新与保留数据

先备份插件源码仓库、发行包、Host 配置和 Harness 用户数据；使用独立测试 profile 验证新官方版本的登录、刷新令牌、模型目录、模型切换和聊天，再替换生产运行版本。不要为了升级删除 Harness home、凭据或 Session 目录。

只有在独立源码已经进入自己的仓库、发行包可重新构建、官方安装验证通过且桌面分发层已有备份后，才考虑删除旧功能分支。删除分支不会代替保存未提交改动；本工具不会执行任何 Git 分支删除或远程发布操作。
