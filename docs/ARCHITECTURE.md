# 架构与实施决策

## 进程

```
Tauri WebView (React)
    → 受控 invoke("rpc") → Tauri Rust
                                 ↓ desktop credential
CLI / MCP stdio → loopback service (Rust) → SQLite
                  ↓ request credential       └→ deduplicated content blobs
             VCS provider process (JSON-RPC / stdio)
```

生产 WebView 不持有 HTTP 凭据。服务随机监听 127.0.0.1 端口；拒绝无凭据请求、带 Origin 的请求及非 POST /rpc。普通 CLI／MCP 凭据不能调用完成评审、批注编辑或安装插件等桌面操作。这是接口职责隔离，**不是对同一 OS 用户恶意进程的安全隔离**。

文件锁保证同一个数据目录只启动一个服务。服务描述文件包含端口及随机凭据；桌面关闭后服务继续运行，Agent 可以读取状态与结果。进程异常退出后下次启动按需恢复，SQLite WAL 保留已经提交的事务。

v0.1 服务统一串行数据库写入。内容捕获期间其他数据库请求可能排队；health 不等待数据库锁。长操作有进程超时，前端可以停止等待；停止等待不等于撤销正在捕获的快照。

## 内容提供者

Git 是单独的 sidecar 子进程模式，与外部 provider 使用同一 JSON-RPC envelope。v0.1 每次启动一个进程处理一个请求后退出，避免驻留插件的状态和重连复杂性。

计划中的 `listChanges` 实际采用**批量返回变更路径与两侧内容**的 v1 协议，减少跨进程逐文件开销；Git 内部通过 NUL 安全的 cat-file 批处理读取对象。resolveRevision/readFile 等细粒度方法仍由 Git 实现，核心评审入口使用批量接口。第三方最小协议见 PLUGINS.md。

插件永远不提供写仓库或任意命令接口。Git 禁用 external diff、textconv、fsmonitor、可选索引写锁及隐式对象拉取，不运行 shell 拼接命令。

工作区捕获连续两次比较，检测到差异则拒绝创建快照。该方式是尽力检测并发编辑，不宣称具备跨文件原子快照能力。

## 存储

相对初稿的实现调整：**内容快照也保存在 SQLite，而不是另设快照文件**。这样新建会话、保存对比、内容引用、完成评审可在同一事务内提交，避免 DB 与文件的双写恢复问题。

- reviews：会话与幂等创建键。
- comparisons：解析后的版本、用户选择、路径列表、内容引用。
- contents：按内容摘要寻址的 JSON 内容块，相同快照内容去重。
- comparison_refs：内容引用，随对比／会话级联删除。
- comments：批注正文、状态、不可变原始锚点。
- submissions：每次完成时的不可变 JSON 结果。
- preferences：界面语言与主题偏好。

新 schema 通过 user_version 管理，遇到高于支持版本的数据库拒绝打开，防止静默降级。评审删除时同步回收没有引用的内容块。SQL 删除不保证物理擦除磁盘旧页。

批注锚点保存 comparisonId、provider、路径、左右侧、行范围、内容摘要、选中内容及上下文。核心重新计算文本摘要，不信任插件提供的摘要。源仓库改变或被删除后，已保存的文本批注仍可恢复。

## 差异与高亮

差异计算和 Shiki/TextMate 高亮运行在可终止 Web Worker 中。虚拟列表仅渲染可见行。大文本跳过高亮；diff 超时可终止 Worker，不阻塞主界面。

原始行号和文本只由内容快照决定，不由高亮 token 决定。高亮资源错误降级为纯文本。原始上下文完全相同且唯一时才尝试跨版本定位，歧义批注留在“其他快照”并可返回原始位置。

## 国际化

语言选择与 fallback 分离：用户显式选择优先，否则匹配系统语言；英文仅作为无匹配及缺失键的降级基准。前端使用稳定翻译键；服务与 MCP 使用稳定机器字段与错误码。外部语言文件允许部分翻译，不执行脚本。

## Windows 构建

Rust 固定到 1.96.0 以便重现构建；项目 Cargo 默认并行度为 2。本机默认高并发构建曾触发 Windows 提交内存不足（1455）和误导性的 rmeta 加载错误，因此降低并行度，不修改全局系统配置。

Tauri NSIS 包同时包含桌面程序与 vividiff-cli sidecar。运行时不需要 Node.js；仅 Node 类型的第三方开发示例需要 Node.js。
