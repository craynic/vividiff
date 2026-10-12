# 依赖许可证

项目自身采用 MIT License。锁定版本见 package-lock.json 与 Cargo.lock。

直接依赖采用以下许可证：
- Tauri / Tauri plugins：MIT OR Apache-2.0。
- React、Vite、TypeScript 生态、i18next、Shiki、jsdiff、TanStack Virtual：以各包声明为准（主要为 MIT；TypeScript 为 Apache-2.0）。
- rusqlite、serde、reqwest、uuid、sha2 等 Rust 依赖：MIT / Apache-2.0 等宽松许可证组合。
- SQLite：public domain。
- TextMate 语法资源有各自上游许可证，不因使用 Shiki 而统一变成项目许可证。
- Windows WebView2 Runtime 属于微软运行时，遵循其发行条款；不作为本项目源码授权。

运行 `node scripts/licenses.mjs` 生成 [完整声明清单](THIRD_PARTY.json)。清单包括传递及目标平台相关依赖，不构成法律意见。发布二进制时应保留适用的第三方版权和许可证声明；第三方用户安装的插件由插件作者负责明确授权。

v0.1 开发验证中运行了 npm production audit；结果见 STATUS.md。许可证清单和漏洞扫描是不同检查，不互相替代。
