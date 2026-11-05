# dsh-enterprise-bundle

dsh-enterprise-bundle 是面向 DeepSeek Harness Web 和 Desktop 的独立插件套件。它让员工用企业账号登录，通过企业网关调用获准的模型，并在会话中使用分配给自己的 MCP 工具。

[中文部署指南](enterprise/README.zh.md) · [English setup guide](enterprise/README.md)

## 功能

- **企业登录**。通过 Harness Admin 的 OIDC 客户端接入单点登录。
- **模型访问**。通过企业网关调用模型，支持企业模型目录、默认模型和会话内模型选择。模型权限和额度由 Harness Admin 管理。
- **员工工具**。按员工授权加载 MCP 工具连接。启用后需要为 OIDC 客户端授予 `mcp.invoke`。

## 准备 Harness Admin

本插件依赖单独部署的 Harness Admin。它提供企业账号登录、模型网关和员工 MCP 连接目录。已有部署时，向管理员获取 OIDC 签发者地址和模型网关地址。本机试用 Web 时，可在 Harness Admin 仓库根目录运行 `make demo-up`，默认访问地址和签发者均为 `http://127.0.0.1:18080`。 [Harness Admin 仓库与启动指南](https://github.com/aDreamyWind/harness-admin#快速启动)

在 Harness Admin 的企业管理端完成以下配置。

1. 在「AI 资源管理 → 模型目录」接入模型供应商，启用至少一个对话模型，并记录它的**模型编码**。如果企业设置了模型策略，确认测试员工有权使用该模型。
2. 在「AI 资源管理 → 应用接入」登记 OIDC 客户端。使用本仓库的默认配置时，为客户端启用 `openid`、`profile`、`model.invoke`、`mcp.invoke` 和 `offline_access`。

   | 客户端 | 在 Harness Admin 中登记的类型 | 回调地址与凭据 |
   | --- | --- | --- |
   | Desktop | 桌面应用 | 登记 `http://127.0.0.1/oauth/callback`，保留不带端口的形式。记录客户端 ID，桌面端使用 PKCE 和随机本机端口。 |
   | Web | 服务端应用 | 登记 Web Host 对外提供的完整回调 URL，例如 `https://harness.company.example/oauth/callback`。记录客户端 ID 和密钥，回调地址必须与 Host 配置完全一致。 |

3. 如需使用企业 MCP 工具，在「AI 资源管理 → MCP 管理」登记服务，生成面向 Harness 员工的连接，再授权给相应员工或部门。

正式部署使用可访问的 HTTPS 签发者和网关地址。 [Harness Admin 开发与部署指南](https://github.com/aDreamyWind/harness-admin/blob/main/docs/development.md)

## 下载并安装

企业插件 `0.2.2` 是正式版，适配 DeepSeek Harness `0.2.2-alpha.2`。宿主兼容版本记录在 [compatibility.json](compatibility.json)。

使用下面的 `dsh plugin` 命令从 npm 安装到对应的 Harness profile。 [npm 上的 dsh-enterprise-bundle](https://www.npmjs.com/package/dsh-enterprise-bundle)

也可以在 GitHub Releases 的 **Assets** 中下载与宿主版本匹配的 `.tgz`，或[从源码构建](#从源码构建)。安装本地包时，把命令中的 `dsh-enterprise-bundle@0.2.2` 换成用引号包住的 `.tgz` 绝对路径。 [GitHub Releases](https://github.com/aDreamyWind/dsh-enterprise-bundle/releases)

### Desktop

先启动一次兼容的 Harness 桌面应用以初始化 profile，然后完全退出。用该桌面安装包附带的 `dsh` 执行：

```sh
dsh plugin --profile desktop add dsh-enterprise-bundle@0.2.2
```

编辑 `$DSH_HOME/profiles/desktop/cordis.patch.yml`。未设置 `DSH_HOME` 时，文件在 `~/.dsh/profiles/desktop/cordis.patch.yml`。把示例中的配置项合入该文件，保留已有配置。 [Desktop 配置示例](enterprise/desktop.patch.example.yml)

- 把 `issuer` 改成 Harness Admin 配置的 OIDC 签发者地址，把 `clientId` 改成登记的 Desktop 客户端 ID。
- 把 `gatewayBaseURL` 改成模型网关的 `/v1` 地址，把默认模型和 `models[].id` 改成模型目录中的编码。
- 把 `gatewayOrigin` 设为网关的来源地址，省略 `/v1`。把 `mcpOrigin` 设为提供员工 MCP 接口的 Harness Admin 来源地址，`directoryUrl` 使用该地址下的 `/api/v1/mcp/connections`。按需调整 `usageUrl` 和 `topUpUrl`。
- 保留 `clientAuthMethod: none` 和 `redirectMode: loopback-random-port`。

保存后重新启动桌面应用。

### Web

在已构建的兼容 Harness 源码目录中执行：

```sh
pnpm dsh --profile enterprise-web --from-default-profile web --dump-config
pnpm dsh plugin --profile enterprise-web add dsh-enterprise-bundle@0.2.2
```

第一条命令仅用于首次创建专用 profile，重复执行会重建同名 profile。安装后，在**启动 Harness Web 的工作目录**编辑 `.env`，替换示例中的地址、客户端凭据和模型编码。每个 Web Host 服务一位员工，客户端密钥仅保存在 Web Host。 [Web 配置示例](.env.example)

```dotenv
HARNESS_ADMIN_OIDC_ISSUER=https://admin.company.example
HARNESS_ADMIN_GATEWAY_BASE_URL=https://admin.company.example/v1
HARNESS_ADMIN_MODELS='[{"id":"your-admin-model-code"}]'
HARNESS_ADMIN_WEB_OIDC_CLIENT_ID=your-web-client-id
HARNESS_ADMIN_WEB_OIDC_CLIENT_SECRET=replace-with-host-only-secret
HARNESS_ADMIN_WEB_OIDC_REDIRECT_URI=https://harness.company.example/oauth/callback
```

运行 `pnpm dsh --profile enterprise-web`。如果 Web Host 在反向代理后面，将对外的 `/oauth/callback` 路径原样转发给 Harness Web Host。

用同一台电脑上的 Harness Admin 演示环境测试 Web 时，把签发者和网关分别设为 `http://127.0.0.1:18080` 和 `http://127.0.0.1:18080/v1`，并在 Admin 与 Web Host 两边登记同一个回调 `http://127.0.0.1:3080/oauth/callback`。使用下面的命令启动本地测试。

```sh
DSH_ENTERPRISE_ALLOW_LOOPBACK_HTTP=true pnpm dsh --profile enterprise-web --port 3080
```

## 员工使用

1. 打开配置好的 Harness。Web 在登录页点击「使用统一登录」，Desktop 从欢迎页发起登录。
2. 在浏览器中用 Harness Admin 的企业员工账号登录并确认授权，然后返回 Harness。
3. 新建会话，从模型选择器选择管理员授予的模型，发一条消息验证调用。已授权的 MCP 工具会随账号加载。如果账号设置里出现「更新 MCP 授权」，点击并重新登录。

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
