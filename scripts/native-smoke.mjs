// Windows native WebView2 smoke test against the actual packaged executable.
// CDP is enabled only for this spawned test process, never in application configuration.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
const executable = resolve(process.argv[2] || 'target/release/vividiff.exe');
const cli = join(dirname(executable), 'vividiff-cli.exe');
const root = mkdtempSync(join(tmpdir(), 'vividiff-native-')),
  data = join(root, 'data'),
  repo = join(root, 'repo');
mkdirSync(data);
mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
git('init', '-q');
git('config', 'user.name', 'Native test');
git('config', 'user.email', 'native@localhost');
git('config', 'core.autocrlf', 'false');
writeFileSync(join(repo, 'native.ts'), 'export const value = 1;\n');
git('add', '.');
git('commit', '-qm', 'baseline');
writeFileSync(join(repo, 'native.ts'), 'export const value = 2;\n');
const env = {
  ...process.env,
  VIVIDIFF_DATA_DIR: data,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9225',
};
const desktop = spawn(executable, [], { env, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 120; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) throw Error('Native WebView2 CDP not available');
  const contexts = browser.contexts();
  let page = contexts.flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools:'));
  if (!page) throw Error('No native window page');
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, null, { timeout: 30000 });
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('rpc', {
      method: 'preferences_set',
      params: { language: 'en' },
    }),
  );
  await page.reload();
  const input = join(root, 'create.json');
  writeFileSync(
    input,
    JSON.stringify({
      repo,
      left: 'HEAD',
      right: 'WORKTREE',
      title: 'Native packaged smoke',
      open: false,
    }),
  );
  const review = JSON.parse(
    execFileSync(cli, ['create', '--input', input], { env, encoding: 'utf8' }),
  );
  const query = join(root, 'query.json');
  writeFileSync(query, JSON.stringify({ reviewId: review.id }));
  const opened = JSON.parse(
    execFileSync(cli, ['open', '--input', query], { env, encoding: 'utf8' }),
  );
  if (!opened.opened) throw Error('Desktop did not open');
  await page
    .getByRole('heading', { name: 'Native packaged smoke', exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'After 1', exact: true }).waitFor({ timeout: 30000 });
  if (await page.getByText('Some highlight resources were rejected.', { exact: true }).count())
    throw Error('Native highlighter failed (check CSP/WASM)');
  await page.getByRole('button', { name: 'After 1', exact: true }).click();
  await page.getByLabel('Your feedback').fill('Native review feedback');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Native review feedback', { exact: true }).waitFor();
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Complete review', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen review', exact: true }).waitFor();
  await page.getByRole('button', { name: 'After 1', exact: true }).waitFor({ timeout: 30000 });
  const result = JSON.parse(
    execFileSync(cli, ['result', '--input', query], { env, encoding: 'utf8' }),
  );
  if (result.result.comments[0].body !== 'Native review feedback')
    throw Error('Incorrect feedback result');
  mkdirSync('.local', { recursive: true });
  await page.screenshot({ path: '.local/native-smoke.png' });
  writeFileSync(
    'docs/NATIVE_SMOKE.json',
    JSON.stringify(
      {
        executable,
        passed: true,
        reviewId: review.id,
        checks: [
          'native WebView2 startup',
          'Tauri IPC',
          'CLI creates real Git comparison',
          'single-instance desktop open',
          'native syntax highlighting',
          'line comment saved',
          'automated user-side UI completion action',
          'CLI reads completed result',
        ],
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Native packaged smoke passed');
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    execFileSync('taskkill', ['/PID', String(desktop.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
  if (existsSync(join(data, 'service.json'))) {
    try {
      const info = JSON.parse(readFileSync(join(data, 'service.json'), 'utf8'));
      process.kill(info.pid);
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}
