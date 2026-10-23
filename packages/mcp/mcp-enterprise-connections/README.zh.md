# @deepseek-ai/dsh-mcp-enterprise-connections

本 Host 插件从 Harness Admin 的 `GET /api/v1/mcp/connections` 读取当前员工获准使用的连接，并通过无状态 Streamable HTTP 网关注册其工具。只支持 MCP `tools/list` 和 `tools/call`；不声明 Admin 尚未提供的 MCP resources 或 prompts。

插件在登录变化和每次 agent step 前重新读取目录。目录失败会移除先前的企业 MCP 工具，并在 Host 日志报告；模型网关和其他工具保持可用。Admin 在每次网关请求中执行最终授权检查。客户端只接收常规工具定义和结果；员工令牌、目录请求和 401 刷新留在 Host。每个 Web Host 应只服务一位员工。

`directoryUrl` 必须为 HTTPS，或显式允许的本机回环 HTTP 地址，且路径固定为 `/api/v1/mcp/connections`。目录返回的网关 URL 必须与目录同源、路径为 `/mcp/{code}`。`serverName` 从连接编码的 SHA-256 摘要稳定派生，满足 Harness 的 32 字符限制。`requestTimeoutMs`、`maxDirectoryBytes` 与 `toolCallTimeoutMs` 可配置。

旧授权缺少 `mcp.invoke` 时，本插件不加载工具。账号设置会提示重新授权；原有模型访问保持可用。目录与连接无法代表跨员工共享 Host 的身份隔离。
