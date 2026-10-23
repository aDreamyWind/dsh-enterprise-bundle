# @deepseek-ai/dsh-mcp-enterprise-connections

This Host plugin reads the signed-in employee's authorized connections from Harness Admin `GET /api/v1/mcp/connections` and registers tools through the stateless Streamable HTTP gateway. It supports MCP `tools/list` and `tools/call`; it does not advertise resources or prompts that Admin has not implemented.

The directory is reloaded on account changes and before each agent step. A failed directory read removes previous enterprise MCP tools and reports the failure in Host logs; model routing and other tools remain available. Admin authorizes every gateway request. Tokens, directory reads, and 401 refresh stay on the Host. One Web Host must serve one employee.

`directoryUrl` must use HTTPS, or explicitly enabled loopback HTTP, and the fixed `/api/v1/mcp/connections` path. Returned gateway URLs must share its origin and use `/mcp/{code}`. A stable SHA-256-derived `serverName` satisfies Harness's 32-character limit. Request deadlines and the directory size limit are configurable.

Existing grants without `mcp.invoke` do not load tools. Account settings offer reauthorization while model access remains available. The directory does not establish identity isolation for a Host shared by multiple employees.
