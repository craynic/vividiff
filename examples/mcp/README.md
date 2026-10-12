# MCP 配置示例

先阅读 [完整接入指南](../../docs/AGENT.md)。这些文件是模板，不会自动注册服务，也未修改你已有的客户端配置。

| 模板 | 合并到 |
| --- | --- |
| `claude-code.mcp.json` | 项目根目录 `.mcp.json`；或按指南使用 `claude mcp add` |
| `cursor.mcp.json` | 项目 `.cursor/mcp.json` 或用户 `~/.cursor/mcp.json` |
| `codex.config.toml` | 用户 `~/.codex/config.toml` |

先替换 `command` 中的路径，并启动同目录的 `vividiff.exe` 一次。保留客户端原有配置，只合并 vividiff 条目。JSON 使用正斜杠路径，避免 Windows 反斜杠转义问题。

首次建议不设置 `VIVIDIFF_DATA_DIR`；如需设置，桌面与 MCP 两侧必须一致。
