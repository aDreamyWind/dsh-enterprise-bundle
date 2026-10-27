# @deepseek-ai/dsh-mcp-enterprise-connections

本 Host 插件从 Harness Admin 的 `GET /api/v1/mcp/connections` 读取当前员工获准使用的连接，并通过无状态 Streamable HTTP 网关注册其工具、resources 与 prompts。resources 接入 Host 原有的 `list_mcp_resources`、`list_mcp_resource_templates` 和 `read_mcp_resource`；声明 prompts 能力的连接会增加列举和读取 prompt 的模型工具。

企业 Skills 从 `GET /api/v1/skills/directory` 注册到 Host 的 Skill 目录，按员工授权和当前发布版本加载。Skill 正文通过受保护的文件接口读取；随附文件通过 `enterprise-skills` MCP resource 服务读取。Skill 文件与上游 MCP 返回的内容都属于外部输入，进入模型上下文前应按普通工具结果审阅。Skills 目录在每次 agent step 前失效，授权撤销后再次查询不会继续暴露旧版本。

若获准使用的上游 MCP 服务声明 `io.modelcontextprotocol/skills`，插件也会把该服务的 `skills/list`、`skills/get` 映射到 Host Skill 目录，并通过同一条员工授权连接读取 `SKILL.md` 和引用文件。上游 Skill 仍由上游服务提供，不会复制到 Admin 的企业 Skill 资产库。

插件在登录变化和每次 agent step 前重新读取目录。目录失败会移除先前的企业 MCP 工具、resources 和 prompts，并在 Host 日志报告；模型网关和其他工具保持可用。Host 输出用 `[enterprise-mcp-tool]` 加 JSON 记录每次实际挂载或移除，JSON 只含 `action`、连接 `code` 和 `toolName`；工具名未变化时不会重复记录。Admin 在每次网关请求中执行最终授权检查。客户端只接收常规工具定义和结果；员工令牌、目录请求和 401 刷新留在 Host。每个 Web Host 应只服务一位员工。

`directoryUrl` 必须为 HTTPS，或显式允许的本机回环 HTTP 地址，且路径固定为 `/api/v1/mcp/connections`。目录返回的网关 URL 必须与目录同源、路径为 `/mcp/{code}`。`serverName` 从连接编码的 SHA-256 摘要稳定派生，满足 Harness 的 32 字符限制。`requestTimeoutMs`、`maxDirectoryBytes` 与 `toolCallTimeoutMs` 可配置。

旧授权缺少 `mcp.invoke` 时，本插件不加载工具。账号设置会提示重新授权；原有模型访问保持可用。目录与连接无法代表跨员工共享 Host 的身份隔离。
