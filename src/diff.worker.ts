/// <reference lib="webworker" />
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { buildRows } from './diff';
import type { Assets } from './types';
const highlighter = createHighlighterCore({
  themes: [import('@shikijs/themes/github-dark')],
  langs: [
    import('@shikijs/langs/javascript'),
    import('@shikijs/langs/typescript'),
    import('@shikijs/langs/tsx'),
    import('@shikijs/langs/jsx'),
    import('@shikijs/langs/json'),
    import('@shikijs/langs/html'),
    import('@shikijs/langs/css'),
    import('@shikijs/langs/rust'),
    import('@shikijs/langs/python'),
    import('@shikijs/langs/markdown'),
    import('@shikijs/langs/yaml'),
    import('@shikijs/langs/toml'),
    import('@shikijs/langs/bash'),
    import('@shikijs/langs/sql'),
    import('@shikijs/langs/go'),
    import('@shikijs/langs/java'),
    import('@shikijs/langs/cpp'),
    import('@shikijs/langs/csharp'),
    import('@shikijs/langs/vue'),
  ],
  engine: createOnigurumaEngine(import('shiki/wasm')),
});
const extensions: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  json: 'json',
  html: 'html',
  css: 'css',
  rs: 'rust',
  py: 'python',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  sql: 'sql',
  go: 'go',
  java: 'java',
  cpp: 'cpp',
  h: 'cpp',
  cs: 'csharp',
  vue: 'vue',
};
self.onmessage = async (
  event: MessageEvent<{ left: string; right: string; path: string; assets: Assets; theme: string }>,
) => {
  const { left, right, path, assets, theme } = event.data;
  try {
    const rows = buildRows(left, right);
    let warning = '';
    if (left.length + right.length < 300000) {
      try {
        const h = await highlighter;
        for (const grammar of assets.grammars) await h.loadLanguage(grammar.value as never);
        for (const t of assets.themes) await h.loadTheme(t.value as never);
        const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
        const custom = assets.grammars.find(
          (g) => g.extensions?.includes(ext) || g.extensions?.includes('.' + ext),
        );
        const lang = custom ? String(custom.value.name) : extensions[ext];
        const selectedTheme =
          (assets.themes.find((t) => t.id === theme)?.value.name as string) || 'github-dark';
        if (lang && h.getLoadedLanguages().includes(lang)) {
          const a = h.codeToTokens(left, { lang: lang as never, theme: selectedTheme }).tokens,
            b = h.codeToTokens(right, { lang: lang as never, theme: selectedTheme }).tokens;
          for (const row of rows) {
            if (row.left) row.left.tokens = a[row.left.line - 1];
            if (row.right) row.right.tokens = b[row.right.line - 1];
          }
        }
      } catch (e) {
        warning = String(e);
      }
    }
    self.postMessage({ rows, warning });
  } catch (e) {
    self.postMessage({ error: String(e) });
  }
};
