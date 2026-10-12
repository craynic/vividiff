# 插件协议 v1

插件永久不能向 vividiff 增加 VCS 写操作、代码编辑、PR/MR 或任意命令入口。独立进程是故障隔离，不是安全沙箱。

## 本地安装

设置 → 插件 → 输入插件目录 → 安装。本地目录复制到应用数据的 plugins/<id>/。目录内必须有 plugin.json；禁止符号链接／reparse point，整体限 32 MiB。已存在 ID 不静默覆盖，可禁用插件后在数据目录手动更换。

可执行 VCS 插件要求勾选信任。不要安装从未审查的仓库中自动发现的插件。本工具不会扫描项目自动运行插件。

## VCS 提供者

```json
{
  "id": "my-provider",
  "version": "0.1.0",
  "protocolVersion": 1,
  "kind": "vcs",
  "runtime": "node",
  "entry": "provider.mjs",
  "capabilities": ["revisions"],
  "permissions": ["read local source content"]
}
```

runtime 支持 native（entry 为可执行文件）和 node（需要本机 Node.js）。entry 必须在插件目录内。每次请求启动一个进程，stdin 接收一行 JSON，stdout 只返回一个 JSON-RPC 响应并退出；日志走 stderr。

请求：
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```
响应：
```json
{"jsonrpc":"2.0","id":1,"result":{"id":"my-provider","protocolVersion":1,"capabilities":["revisions"]}}
```

核心使用的接口：

| method | 输入 | result |
| --- | --- | --- |
| initialize | {} | protocolVersion=1、id、capabilities |
| getCapabilities | repo | index、worktree、mergeBase 等 boolean |
| listRevisions | repo、offset | items: [{id,label}]、nextOffset |
| listChanges | repo、left、right、mode | 解析后的 left/right、files |

listChanges 是批量快照接口，返回稳定版本标识及已冻结内容。插件负责解析选择和检测捕获过程中的源内容变化；核心负责保存、diff、批注和评审。

```json
{
  "left": "revision-before",
  "right": "revision-after",
  "files": [{
    "oldPath": "src/example.txt",
    "path": "src/example.txt",
    "status": "M",
    "left": {"kind":"text","text":"before\n","size":7},
    "right": {"kind":"text","text":"after\n","size":6}
  }]
}
```

- 新增／删除文件对应一侧为 null。
- status：A/D/M/R 等展示标识；rename 同时提供 oldPath/path。
- kind：text、binary、large、submodule、symlink；非文本可只提供 size 与诊断元数据。
- 核心重新计算文本 hash，忽略插件声称的文本摘要。
- 路径必须唯一；当前限制为 3000 变更文件、每侧单文件 2 MiB 文本、总计 24 MiB 文本。
- 响应最多 64 MiB，进程超时 120 秒；错误返回 error 对象，不能在 stdout 混入日志。
- 只读契约由可信插件实现保证；不把执行权限误称为受沙箱限制。

Git 还实现 detectRepository、resolveRevision、readFile、getMergeBase。新增 provider 不需要采用 Git 的 HEAD、SHA 或暂存区概念。参考可运行的非 Git 提供者 `examples/plugins/fixture/`：把 before.txt/after.txt 所在目录作为 repo，左右选择 before/after。

## 编程语言高亮

```json
{
  "id": "vivid-notes",
  "version": "0.1.0",
  "protocolVersion": 1,
  "kind": "grammar",
  "resource": "grammar.json",
  "extensions": ["vnote"]
}
```

resource 是 Shiki 可加载的 TextMate grammar JSON，必须包含 name、scopeName、patterns。示例见 examples/plugins/grammar。语法依赖需要由已加载语法提供；依赖缺失会显示诊断并降级纯文本。v0.1 不提供联网解析依赖。

扩展名冲突按插件目录名排序后的第一个生效；建议避免重复声明同一扩展名。ID、语法 name 和主题 name 应唯一。后续可以增加显式优先级设置。

## 高亮主题

kind=theme，resource 指向 TextMate/Shiki 主题 JSON；安装后可在设置选择。参考 examples/plugins/theme。当前主题包影响代码 token 色彩，不改变整个应用的 CSS 布局。

资源大小限制 4 MiB；加载失败不影响批注和快照。高亮运行在可终止 Worker 中，不执行插件 JavaScript。超过文本阈值会跳过高亮，超时会终止该 Worker。
