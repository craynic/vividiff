# Code Agent 通过 MCP 接入 vividiff

本文适用于 **Windows 上运行的本地 Code Agent**，包括 Claude Code、Codex 和 Cursor。vividiff 使用 **MCP stdio**：客户端启动 `vividiff-cli.exe mcp`，通过标准输入／输出调用工具。

不需要 API Key、OAuth、Node.js 或手动配置 HTTP 端口。Git 对比仍需要本机安装 Git，并确保 Agent 启动的进程可以找到它。

> 下文配置以本仓库的构建路径 `D:/projects/vividiff/target/release/` 为例。如果使用安装包，把路径换成实际安装目录；`vividiff-cli.exe` 与 `vividiff.exe` 位于同一目录。不要把示例路径原样复制到其他机器。
>
> 验证边界：当前已通过标准 MCP stdio 协议测试，以及 Windows 原生界面与 CLI 的完整评审自动化测试。以下客户端配置格式依据官方文档编写，未逐一进行各客户端的真人接入验收。

## 1. 接入后的工作方式

```text
Code Agent 调用 review_create
    ↓ 返回 reviewId，唤起 vividiff 桌面窗口
用户查看具体改动，可自由切换对比版本并添加批注
    ↓ 用户点击“完成评审”
Code Agent 调用 review_status → review_result
    ↓ 读取全部批注及其原始版本、路径、行范围和代码上下文
Code Agent 在 vividiff 之外处理反馈
```

vividiff 不修改源代码，也不提供暂存、提交、合并、冲突解决或 PR/MR 管理接口。完成评审由用户在桌面界面执行，不是由 Agent 调用 MCP 代替完成。

## 2. 准备可执行文件

### 2.1 使用安装包

安装 `vividiff_0.1.0_x64-setup.exe`，找到安装目录中的两个程序：

```text
<安装目录>/
├── vividiff.exe       # 桌面界面
└── vividiff-cli.exe   # CLI、MCP 桥接和本地服务
```

MCP 的 `command` 必须指向 **vividiff-cli.exe**，不是桌面程序。

### 2.2 使用当前源码构建结果

本项目已有构建结果时，可以直接使用：

```text
D:/projects/vividiff/target/release/vividiff.exe
D:/projects/vividiff/target/release/vividiff-cli.exe
```

需要重新构建时，在项目根目录运行：

```powershell
npm ci
npm run desktop:build
```

### 2.3 首次启动并检查

在 PowerShell 中运行（安装包用户替换 `$bin`）：

```powershell
$bin = 'D:\projects\vividiff\target\release'
$cli = Join-Path $bin 'vividiff-cli.exe'

Test-Path $cli
Test-Path (Join-Path $bin 'vividiff.exe')
& $cli --help
git --version

Start-Process (Join-Path $bin 'vividiff.exe')
```

确认桌面窗口能打开。**首次启动会向当前数据目录注册桌面程序路径**，后续 Agent 才能自动唤起窗口。路径发生变化后，重新打开新位置的桌面程序以更新注册。

日常无需手动运行 `serve`。CLI／MCP 会按需启动本地服务。

可复制的配置文件也已放在 [examples/mcp/](../examples/mcp/README.md)，使用前替换本机路径并合并原有配置。

## 3. 配置 Claude Code

### 方式 A：命令行添加，推荐个人使用

在 PowerShell 中执行：

```powershell
claude mcp add --transport stdio --scope user vividiff -- "D:/projects/vividiff/target/release/vividiff-cli.exe" mcp
claude mcp get vividiff
```

说明：

- `--scope user`：为当前用户的所有项目启用。
- `--` 后面是服务端可执行文件及其参数。
- 最后的 `mcp` 是 vividiff 的子命令，不能省略。
- 如提示同名服务已存在，先检查旧配置，不要重复添加另一份。

重新进入 Claude Code，运行 `/mcp`，确认 `vividiff` 已连接。若客户端要求信任或工具授权，按提示确认你刚添加的本地服务；不需要关闭全局权限保护。

### 方式 B：项目配置文件

在**要评审的项目根目录**创建或合并 `.mcp.json`：

```json
{
  "mcpServers": {
    "vividiff": {
      "type": "stdio",
      "command": "D:/projects/vividiff/target/release/vividiff-cli.exe",
      "args": ["mcp"]
    }
  }
}
```

已有其他服务时，仅添加 `mcpServers.vividiff`，不要覆盖整个文件。项目配置首次加载可能需要在交互会话中批准。团队成员需要替换本机路径；不要把个人绝对路径当成所有机器通用的配置。

两种方式选择一种即可，避免同名配置在不同作用域互相覆盖。

## 4. 配置 Codex

编辑用户配置：

```text
Windows: %USERPROFILE%\.codex\config.toml
通用写法: ~/.codex/config.toml
```

保留原有配置，追加：

```toml
[mcp_servers.vividiff]
command = "D:/projects/vividiff/target/release/vividiff-cli.exe"
args = ["mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 180
```

重新启动 Codex 会话，在客户端的 MCP 状态入口检查 `vividiff` 及其工具。也可以使用 CLI 查看：

```powershell
codex mcp list
```

- `startup_timeout_sec` 用于进程启动与 MCP 初始化。
- `tool_timeout_sec` 用于一次工具调用，例如捕获对比内容；**不是用户评审的时间限制**。
- 支持项目配置的 Codex 版本也可使用项目内 `.codex/config.toml`，但项目需要受信任。
- 不要将前述 JSON `mcpServers` 配置直接粘贴进 TOML 文件。

## 5. 配置 Cursor

选择一个作用域：

- 项目级：`<项目根目录>/.cursor/mcp.json`。
- 用户级：`%USERPROFILE%/.cursor/mcp.json`（即 `~/.cursor/mcp.json`）。

创建或合并以下配置：

```json
{
  "mcpServers": {
    "vividiff": {
      "type": "stdio",
      "command": "D:/projects/vividiff/target/release/vividiff-cli.exe",
      "args": ["mcp"]
    }
  }
}
```

在 Cursor 的 MCP／工具设置中确认服务启用；必要时重新加载窗口或重启客户端。进入 Agent 会话后，确认可以发现下节列出的五个工具。

不同 Cursor 版本的设置入口名称可能不同，以客户端显示的 MCP 服务列表为准。

## 6. 验证 MCP 已连接

连接成功后应能发现：

| 工具 | 用途 |
| --- | --- |
| `review_create` | 创建评审，默认尝试打开桌面窗口 |
| `review_open` | 打开已有评审 |
| `review_status` | 查询评审状态与最新完成序号 |
| `review_comments` | 分页读取当前批注，可能包含未完成的草稿反馈 |
| `review_result` | 读取已完成的不可变结果 |

客户端可能为工具增加前缀，例如 `mcp__vividiff__review_create`；使用客户端实际暴露的名称即可。

### 不经过 Agent 的底层检查

如果客户端显示连接失败，可先在 PowerShell 中验证标准输入／输出协议。下面沿用第 2 节的 `$cli`：

```powershell
$messages = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"vividiff-check","version":"1.0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
)
$messages | & $cli mcp
```

预期：

1. `id: 1` 的响应中包含 `serverInfo.name: "vividiff"`。
2. `id: 2` 的响应中包含上述五个工具。
3. `notifications/initialized` 没有响应，这是正常的。

单独运行 `vividiff-cli.exe mcp` 后没有文字输出也正常：进程正在等待 MCP 输入，不代表死机。不要在 MCP 命令前后加会向 stdout 打印欢迎语的脚本。

## 7. 实际发起一次评审

### 7.1 可以直接发给 Agent 的指令

```text
请通过 vividiff MCP 发起一次代码评审：
- 仓库：D:/projects/my-app
- 修改前：HEAD
- 修改后：WORKTREE
- 标题：检查本次改动
- 说明：请重点检查边界条件和错误处理。

调用 review_create，并为这次评审设置唯一的 idempotencyKey。
记住返回的 id，后续作为 reviewId 使用。
发起后先停止修改代码，等待我在 vividiff 中完成评审。
当我说“评审完成”后，查询 review_status；确认 completed 后读取 review_result。
根据每条批注的原始版本和代码上下文理解反馈，不要假设我一直使用初始对比版本。
```

替换仓库路径。这里采用“用户说评审完成后继续”的方式，不依赖特定 Agent 的后台等待功能。

### 7.2 `review_create` 调用参数

```json
{
  "repo": "D:/projects/my-app",
  "provider": "git",
  "source": "vcs",
  "left": "HEAD",
  "right": "WORKTREE",
  "mode": "direct",
  "title": "检查本次改动",
  "description": "请重点检查边界条件和错误处理。",
  "idempotencyKey": "my-app-task-42-review-1",
  "open": true
}
```

参数约定：

| 参数 | 说明／默认值 |
| --- | --- |
| `repo` | VCS 评审必须提供；建议使用 Windows 绝对路径 |
| `provider` | 默认 `git`；外部提供者使用插件 ID |
| `source` | 默认 `vcs`；普通文件对比使用 `files` |
| `left` / `right` | Git 默认 `HEAD` / `WORKTREE` |
| `mode` | 默认直接对比；可传 `direct` 或 `merge-base` |
| `title` / `description` | 展示给用户的标题和评审说明 |
| `idempotencyKey` | 建议提供；同一创建操作的重试复用同一键 |
| `open` | 默认 `true`；`false` 时仅创建，不唤起窗口 |

创建结果示意（省略其他字段）：

```json
{
  "id": "7b34129c-1111-4444-8888-abcdef123456",
  "title": "检查本次改动",
  "status": "in_progress",
  "latestSequence": 0,
  "desktop": {
    "opened": true,
    "reviewId": "7b34129c-1111-4444-8888-abcdef123456"
  }
}
```

**创建返回字段叫 `id`，后续调用参数叫 `reviewId`。**

当前 MCP 以 `content[0].text` 返回 JSON 文本，并用 `isError` 标记工具错误；开发自定义客户端时需要解析该文本，而不是假设存在 `structuredContent`。多数 Agent 会直接读取客户端展示的工具文本。

幂等键规则：

- 同一次创建重试：使用相同键，防止重复会话。
- 换了仓库、对比范围或开启新一轮评审：使用新键。
- 当前同键会返回原会话，不会用新参数更新原会话。

### 7.3 用户评审

用户可以在 vividiff 中：

1. 查看文件及具体改动。
2. 切换对比版本或返回历史快照。
3. 添加文件级、单行或多行批注。
4. 点击“完成评审”。

关闭窗口不等于完成评审。没有批注也可以完成。完成只表示反馈收集结束，不表示批准合并，更不会执行任何 VCS 操作。

### 7.4 `review_status` 查询状态

```json
{
  "reviewId": "7b34129c-1111-4444-8888-abcdef123456"
}
```

关注这些返回字段：

```json
{
  "id": "7b34129c-1111-4444-8888-abcdef123456",
  "status": "completed",
  "latestSequence": 1
}
```

- `in_progress`：用户还在评审，不要把当前批注当作最终反馈。
- `completed`：可以读取对应的正式结果。
- `cancelled`：评审已取消，应停止等待，不当作成功完成。

**当前没有 MCP 完成推送或 `review_wait` 工具。** Agent 可在用户继续对话后查询，或在宿主支持的后台工作机制中低频轮询，例如每 5–10 秒一次并设置总等待期限。不要不断创建新会话，也不要毫秒级轮询。

### 7.5 `review_result` 读取正式反馈

```json
{
  "reviewId": "7b34129c-1111-4444-8888-abcdef123456",
  "sequence": 1
}
```

`sequence` 可省略，省略时读取最近一次已完成结果。未产生结果时返回：

```json
{"available": false, "result": null}
```

完成后的结果示意（节选）：

```json
{
  "available": true,
  "result": {
    "schemaVersion": 1,
    "reviewId": "7b34129c-1111-4444-8888-abcdef123456",
    "submissionId": "c139b120-2222-4444-8888-abcdef123456",
    "sequence": 1,
    "comments": [
      {
        "id": "a4bd504e-3333-4444-8888-abcdef123456",
        "body": "这里需要处理空值。",
        "status": "open",
        "anchor": {
          "comparisonId": "e8d7ac23-4444-4444-8888-abcdef123456",
          "provider": "git",
          "path": "src/example.ts",
          "oldPath": "src/example.ts",
          "side": "right",
          "startLine": 12,
          "endLine": 14,
          "selectedText": "被评审时选中的代码",
          "context": "被评审时保存的周围代码"
        }
      }
    ]
  }
}
```

Agent 应当：

- 处理结果中的全部批注，不只看当前文件或初始版本。
- 区分 `open` 与 `resolved`，避免重复处理已解决反馈。
- 依据原始 `comparisonId`、版本、路径、行范围和上下文定位，不能直接把旧行号应用到当前工作区。
- 按 `reviewId + sequence` 去重消费结果。
- 用户重新打开会话后，旧结果仍可读取；必须结合 `review_status` 判断新一轮是否已经完成。`available: true` 本身不表示当前一轮已完成。

## 8. 常用对比参数

以下仅列出差异参数，仍需提供 `repo`、标题等字段：

| 场景 | `left` | `right` | `mode` |
| --- | --- | --- | --- |
| 当前工作区相对 HEAD 的变化 | `HEAD` | `WORKTREE` | `direct` |
| 已暂存的变化 | `HEAD` | `INDEX` | `direct` |
| 尚未暂存的变化 | `INDEX` | `WORKTREE` | `direct` |
| 两个提交的直接差异 | 提交 A | 提交 B | `direct` |
| 两个分支的直接差异 | `main` | `feature/example` | `direct` |
| 从共同祖先观察目标分支变化 | `main` | `feature/example` | `merge-base` |

`WORKTREE` 也包含未被忽略的未跟踪文件。共同祖先模式只接受可解析到提交的两个版本，不接受 `INDEX`、`WORKTREE` 或 `EMPTY`。选择版本只读取内容，不 checkout；远端分支引用必须已在本地存在，vividiff 不 fetch。

### 普通两文件对比

```json
{
  "source": "files",
  "left": "D:/tmp/before.ts",
  "right": "D:/tmp/after.ts",
  "title": "对比两个文件",
  "idempotencyKey": "files-task-42-review-1",
  "open": true
}
```

### 分页读取当前批注

`review_comments` 参数：

```json
{
  "reviewId": "7b34129c-1111-4444-8888-abcdef123456",
  "offset": 0,
  "limit": 100,
  "status": "open"
}
```

返回 `items`、`total`、`offset` 和 `draft`。默认每页 100 条，上限 500 条。省略 `status` 才会包含所有状态；如果需要检查所有反馈，不能只读取 `open`。正式完成结果优先使用 `review_result`。

## 9. 可选：自定义共享数据目录

**初次接入建议不要配置此变量**，让桌面与 CLI 使用同一 Windows 用户的默认应用数据目录。实际目录可在 vividiff 设置中查看。

需要指定目录时，桌面与 MCP 必须一致。

先从设置了变量的 PowerShell 启动桌面：

```powershell
$env:VIVIDIFF_DATA_DIR = 'D:\vividiff-data'
Start-Process 'D:\projects\vividiff\target\release\vividiff.exe'
```

如果桌面已经运行，先正常退出原窗口，再从这个终端启动。已有服务和已运行窗口不会因为你修改环境变量自动切换目录。

Claude Code／Cursor 的服务条目增加：

```json
{
  "type": "stdio",
  "command": "D:/projects/vividiff/target/release/vividiff-cli.exe",
  "args": ["mcp"],
  "env": {
    "VIVIDIFF_DATA_DIR": "D:/vividiff-data"
  }
}
```

这是单个服务条目，放在 `mcpServers.vividiff` 下，不是完整根配置。

Codex 在对应表下增加环境表：

```toml
[mcp_servers.vividiff.env]
VIVIDIFF_DATA_DIR = "D:/vividiff-data"
```

更换数据目录不是迁移数据；旧会话仍在原目录。不要直接编辑、复制或暴露 `service.json` 中的内部凭据来连接 Agent。

## 10. CLI 等待与 Skill

MCP 本身不要求安装 Skill。如果希望 Agent 始终遵循相同评审流程，可以把 [通用 Skill 示例](../skills/vividiff/SKILL.md) 按宿主支持的方式安装，或将其流程写入项目 Agent 指令文件。不同客户端的 Skill 安装位置不同，不应假定放入一个通用目录就会自动加载。

若宿主允许执行本地 CLI，可用有限时等待代替 MCP 轮询：

```powershell
$cli = 'D:\projects\vividiff\target\release\vividiff-cli.exe'
$query = Join-Path $env:TEMP 'vividiff-review-query.json'
@{
  reviewId = '替换成真实 reviewId'
  timeoutSeconds = 300
} | ConvertTo-Json | Set-Content -Encoding Ascii $query

& $cli wait --input $query --json
& $cli result --input $query --json
```

此查询文件只包含 ASCII 字段、UUID 和数字，所以使用 Ascii 避免 Windows PowerShell 5.1 写入 UTF-8 BOM。创建包含中文标题的请求文件时，应使用**不带 BOM 的 UTF-8**。

- 等待超时返回 `timedOut: true`，不取消、不删除评审。
- 用户取消评审时返回 `cancelled: true`。
- Ctrl+C 结束 CLI 也不删除会话。
- CLI 输出就是 JSON；MCP 则将 JSON 放在工具结果文本中。
- 不要把批注或其他用户文本拼接成 shell 命令。

## 11. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 找不到程序／ENOENT | 使用 CLI 的绝对路径；`command` 只放 exe 路径，`mcp` 放入 `args` |
| 配置加载后没有五个工具 | 重启会话，检查作用域、同名覆盖、服务启用状态及客户端信任审批 |
| 单独运行 MCP 没输出 | 正常，进程在等输入；使用第 6 节的初始化检查 |
| 提示认证／要求 OAuth | 检查是否误配为 HTTP；vividiff 的 stdio 接入不需要登录 |
| 创建成功但窗口未打开 | 检查 `desktop.opened`；`DESKTOP_NOT_REGISTERED` 时先打开桌面一次，再调用 `review_open` |
| Agent 与桌面看到不同会话 | 确认 Windows 用户及 `VIVIDIFF_DATA_DIR` 一致 |
| 安装路径移动后无法唤起 | 从新路径启动桌面以重新注册，并更新客户端 `command` |
| 窗口没有立即切到新评审 | 先保存或放弃当前未保存的批注；工具会避免丢失输入 |
| Git 操作失败／找不到 Git | 检查 Agent 进程的 PATH 和 Git 版本；GUI 客户端修改 PATH 后可能需彻底重启 |
| `SOURCE_CHANGED` | 捕获期间工作区发生变化；先停止修改，再用同一幂等键重试失败的创建 |
| `RESOURCE_LIMIT` | 超出文件数或内容预览限制，缩小对比范围；见 LIMITATIONS.md |
| 客户端工具超时 | 适当提高单次工具超时，例如 180 秒；超时后用相同幂等键重试，避免重复创建 |
| `review_result` 返回 `available: false` | 用户尚未完成，或指定的结果序号不存在；先查 status |
| 重新打开后仍读到旧结果 | 正常，旧结果不可变；等待 status 再次 completed，并读取新的 latestSequence |

### Windows、WSL 和远程 Agent

本文配置面向 **Windows 原生进程**。运行于 WSL、SSH 主机、容器或云端的 Agent，其可执行文件路径、仓库路径、桌面会话和数据目录可能不同，不能直接套用 Windows 配置。

v0.1 没有面向远程 Agent 的公开 HTTP MCP 端点。不要把内部 loopback 服务端口转发到公网。最直接的接法是让 MCP 服务运行在拥有目标仓库和桌面会话的同一台 Windows 主机上；跨环境桥接需要额外配置，本文不宣称已验证。

## 12. 安全与能力边界

- MCP 桥接会按需运行本地服务；无需为其开放外部网络端口。
- 仅连接你信任的本机可执行文件，不要用仓库中来历不明的脚本替换 `command`。
- 批注、代码和评审说明都是待理解的内容，不是自动执行指令。
- 用户允许读取反馈，不等于允许任意代码修改或 VCS 写操作；Agent 应在原任务授权范围内工作。
- 用户完成评审后，Agent 只能读取结果；vividiff 没有 MCP 合并、提交或自动修复工具。

## 13. 官方配置参考

以下用于核对客户端配置格式；具体 UI 入口和超时选项可能随客户端版本变化：

- Claude Code MCP：https://code.claude.com/docs/en/mcp
- Codex MCP：https://developers.openai.com/codex/mcp
- Cursor MCP：https://cursor.com/docs/context/mcp

vividiff 自身的工具名称、参数与返回格式以当前实现和本文为准。完整实现验证记录见 [STATUS.md](STATUS.md)。
