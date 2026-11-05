# dsh-enterprise-bundle

dsh-enterprise-bundle 是面向 DeepSeek Harness Web 和 Desktop 的独立插件套件。它让员工用企业账号登录，通过企业网关调用获准的模型，并在会话中使用分配给自己的 MCP 工具。

[中文部署指南](enterprise/README.zh.md) · [English setup guide](enterprise/README.md)

## 功能

- **企业登录**。通过 Harness Admin 的 OIDC 客户端接入单点登录。
- **模型访问**。通过企业网关调用模型，支持企业模型目录、默认模型和会话内模型选择。模型权限和额度由 Harness Admin 管理。
- **员工工具**。按员工授权加载 MCP 工具连接。启用后需要为 OIDC 客户端授予 `mcp.invoke`。

## 下载并安装

企业插件 `0.2.2` 是正式版，适配 DeepSeek Harness `0.2.2-alpha.2`。宿主兼容版本记录在 [compatibility.json](compatibility.json)。

从 [GitHub Releases](https://github.com/aDreamyWind/dsh-enterprise-bundle/releases) 选择与宿主版本匹配的发行版，在 **Assets** 中下载 `.tgz` 安装包。如果暂时没有可用的发行包，可以[从源码构建](#从源码构建)。

运行前需在 Harness Admin 中准备 OIDC 客户端和模型网关。启用员工 MCP 工具时，还需配置员工连接目录。以下命令中的 `/absolute/path/to/enterprise-bundle.tgz` 请替换为下载文件的实际路径。

### Desktop

先启动一次兼容的 Harness 桌面应用以初始化 profile，然后完全退出。用该桌面安装包附带的 `dsh` 执行：

```sh
dsh plugin --profile desktop add "/absolute/path/to/enterprise-bundle.tgz"
```

使用 OIDC 公开客户端，按 [Desktop 配置示例](enterprise/desktop.patch.example.yml) 补齐企业地址、客户端 ID 和模型，再启动桌面应用。配置文件的位置见 [Desktop 部署指南](enterprise/README.zh.md#安装到官方桌面端)。

### Web

在已构建的兼容 Harness 源码目录中执行：

```sh
pnpm dsh --profile enterprise-web --from-default-profile web --dump-config
pnpm dsh plugin --profile enterprise-web add "/absolute/path/to/enterprise-bundle.tgz"
```

第一条命令仅用于首次创建专用 profile，重复执行会重建同名 profile。按 [Web 配置示例](.env.example) 在 Harness 工作目录配置 `.env`，然后运行 `pnpm dsh --profile enterprise-web`。每个 Web Host 服务一位员工，客户端密钥保存在 Web Host。详见 [Web 部署指南](enterprise/README.zh.md#安装到官方-web)。

## 从源码构建

准备 Node.js 24.9 或更新版本，以及 pnpm、npm、Git 和 tar。下面的命令在本仓库根目录运行，使用已验证的 DeepSeek Harness `0.2.2-alpha.2` 上游提交构建安装包。

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness-sdk
git -C ../deepseek-harness-sdk checkout --detach ce7073d51254c26cd63b22a60835b8f948deb447
pnpm --dir ../deepseek-harness-sdk install --frozen-lockfile
node enterprise/build.mjs --harness ../deepseek-harness-sdk --verify
```

构建成功后会打印 `.tgz` 的绝对路径。已有兼容的 Harness 源码检出目录时，可以安装其依赖后直接把目录传给 `--harness`。

## 许可证

源码按 [MIT 许可证](LICENSE) 提供。安装包随附打入包内的上游及第三方代码的许可文本。
