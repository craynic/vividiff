# 界面语言文件

**英文是降级语言，不是固定界面默认语言。** 未手动选择时匹配系统语言；找不到已加载的对应语言才显示英文。用户可以切换回“跟随系统”。

## 安装

1. 在设置中查看应用数据目录。
2. 在其中创建 `locales/`，放入 JSON 文件。
3. 点击“重新加载语言”，或重新启动应用。
4. 新语言自动出现在语言下拉列表中，无需编译。

```json
{
  "schemaVersion": 1,
  "locale": "fr",
  "nativeName": "Français",
  "translations": {
    "common": {
      "cancel": "Annuler",
      "settings": "Paramètres"
    }
  }
}
```

示例：`examples/locales/fr.json`。完整键清单以 `src/locales/en.json` 为准。

- 允许只翻译一部分；缺失键、空字符串和错误插值回退英文。
- `nativeName` 是该语言的自称。
- locale 使用 BCP 47 风格标识，例如 fr、de、ja、pt-BR。
- 同一个 locale 不允许重复；内置 en 和 zh-CN 不被外部文件覆盖。
- 修改现有文件后重新加载即可更新；不监控每次磁盘写入，避免加载写到一半的 JSON。
- 最大文件大小 1 MiB，schemaVersion 必须为 1。
- 无效文件在设置中显示诊断，不使整个界面崩溃。
- 所选语言被移除／不可加载时，暂时回退英文并提示；语言偏好仍保留，可修复文件后重新加载。

## 文案规则

命名空间当前为 common；翻译键与实际英文资源对应。变量名称不可改变：

```json
{"countFiles":"{{count}} fichiers","lineRange":"Lignes {{start}}–{{end}}"}
```

文本直接显示，不解释为 HTML，不加载脚本或远端资源。源代码、路径、版本名称、用户批注与 Agent 评审说明不翻译。

切换语言不重载评审，不丢失正在编辑的批注。时间和数字展示通过 Intl 格式化，存储与 Agent JSON 协议不随语言变化。

界面语言文件独立于 TextMate 高亮语法包。首版未验收 RTL 布局，不能仅凭增加 RTL 翻译就视为完整支持。
