# vividiff

本地代码对比与批注工具，面向人与 Code Agent 协作。**不是 VCS 客户端**。

- Git 提交、分支、标签、暂存区、工作区对比；支持普通两文件对比。
- 并排／统一 diff、语法高亮、虚拟滚动、变更导航。
- 文件／单行／多行批注，快照历史、不可变评审结果。
- MCP stdio 与 JSON CLI：Agent 发起 → 人评审 → Agent 读取反馈。
- 外部只读 VCS 插件、声明式高亮语法／主题资源。
- 界面默认跟随系统，可通过 JSON 文件增加语言；缺失文案降级英文。

**永远不做**合并、冲突解决、PR/MR 管理、分支管理、提交、暂存或代码编辑。相关操作由 Agent 在 vividiff 之外完成。

## Windows 开发

要求：Node.js 22+、Rust（由 `rust-toolchain.toml` 固定）、Visual Studio C++ Build Tools、WebView2 Runtime、Git **2.42+**（使用 NUL 安全的 cat-file 批处理）。

```powershell
npm ci
npm run desktop:dev
```

`desktop:dev` 先构建 Rust CLI／服务 sidecar，再启动 Vite 和 Tauri。单独 `npm run dev` 只是前端开发服务器，没有桌面 IPC；普通浏览器默认无法连接评审服务。

```powershell
npm run desktop:build
```

当前 Windows 安装包：[`vividiff_0.1.0_x64-setup.exe`](target/release/bundle/nsis/vividiff_0.1.0_x64-setup.exe)。已通过独立目录安装、原生评审闭环和卸载测试。

安装包输出到 `target/release/bundle/nsis/`。安装包**未签名**，对外发行前需安排代码签名。本版本只验收 Windows；macOS／Linux 留待后续。

## 使用

1. 新建评审，填入仓库路径和左右版本（默认 `HEAD → WORKTREE`）。
2. 选择文件；点击行号添加批注，Shift 点击选择多行。
3. “捕获 / 对比”生成新快照；历史下拉框返回以前的快照。
4. “完成评审”冻结所有快照的批注结果，不执行任何仓库操作。
5. 重新打开评审后可继续添加反馈，再次完成产生新的结果序号。

版本标识：
- 分支／标签／提交：读取对应提交，不 checkout。
- `INDEX`：暂存区。
- `WORKTREE`：工作区，包括未被忽略的未跟踪文件。
- `EMPTY`：空内容基准，用于初始版本。
- 共同祖先模式只接受两个提交版本；仅计算 merge-base，不合并。

## Agent 接入

参见 [Agent 接入文档](docs/AGENT.md) 与 [Skill 示例](skills/vividiff/SKILL.md)。

```json
{
  "mcpServers": {
    "vividiff": {
      "command": "C:\\path\\to\\vividiff-cli.exe",
      "args": ["mcp"]
    }
  }
}
```

先启动桌面应用一次，注册其本机启动路径。之后 Agent 创建评审可自动唤起窗口；未注册时仍返回持久化 reviewId 及明确的未打开状态。

## 扩展

- [界面语言文件](docs/LANGUAGES.md)
- [VCS、高亮与主题插件](docs/PLUGINS.md)
- [架构与实施决策](docs/ARCHITECTURE.md)
- [计划与里程碑](docs/PLAN.md)
- [实现与验证记录](docs/STATUS.md)
- [已知限制与排障](docs/LIMITATIONS.md)

## 检查

```powershell
npm test
npm run build
cargo test -p vividiff-core
cargo clippy -p vividiff-core --all-targets -- -D warnings
npm run test:e2e
```

端到端测试使用本机 Microsoft Edge，临时 Git 仓库、真实 Rust 服务和测试专用浏览器桥接。该桥接不打包、不进入生产界面。测试覆盖接口并不替代所有第三方 Agent 客户端的兼容性验证。

## 数据与隐私

数据默认保存在当前用户 Windows 应用数据目录，实际路径可在设置中复制。可通过 `VIVIDIFF_DATA_DIR` 覆盖（桌面与 CLI 必须使用同一路径）。

代码快照、批注、语言文件及插件均保存在本机。vividiff 不上传代码、不连接代码托管平台。已评审内容的副本可能包含敏感信息，请保护数据目录；数据库不提供静态加密。删除评审会删除引用并回收无引用内容；这不等于磁盘级安全擦除。

第三方可执行 VCS 插件拥有当前用户权限，**不是沙箱**，只安装可信来源。

License: MIT. 依赖许可证见 [许可证说明](docs/LICENSES.md)。
