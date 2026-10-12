// Test-only browser adapter. Never bundled or shipped with vividiff.
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'vividiff-e2e-'));
const data = join(root, 'data'),
  repo = join(root, 'repo');
mkdirSync(repo);
mkdirSync(data);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
git('init', '-q');
git('config', 'user.name', 'Test');
git('config', 'user.email', 'test@localhost');
git('config', 'core.autocrlf', 'false');
writeFileSync(
  join(repo, 'hello.ts'),
  'export const message = "before";\nexport const count = 1;\n',
);
git('add', '.');
git('commit', '-qm', 'baseline');
writeFileSync(join(repo, 'hello.ts'), 'export const message = "after";\nexport const count = 2;\n');
writeFileSync(join(repo, 'new.txt'), 'A new file\n');
mkdirSync(join(data, 'locales'));
writeFileSync(
  join(data, 'locales', 'fr.json'),
  JSON.stringify({
    schemaVersion: 1,
    locale: 'fr',
    nativeName: 'Français',
    translations: { common: { cancel: 'Annuler', settings: 'Paramètres' } },
  }),
);
mkdirSync('.local', { recursive: true });
writeFileSync('.local/e2e-fixture.json', JSON.stringify({ root, data, repo }));
const service = spawn(resolve('target/debug/vividiff-cli.exe'), ['serve'], {
  env: { ...process.env, VIVIDIFF_DATA_DIR: data },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
service.stderr.pipe(process.stderr);
for (let i = 0; i < 100 && !existsSync(join(data, 'service.json')); i++)
  await new Promise((r) => setTimeout(r, 100));
const info = JSON.parse(readFileSync(join(data, 'service.json'), 'utf8'));
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:1420');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS,GET');
  if (req.method === 'OPTIONS') {
    res.end();
    return;
  }
  if (req.url === '/health') {
    res.end('ok');
    return;
  }
  try {
    let body = '';
    for await (const c of req) body += c;
    const reply = await fetch('http://127.0.0.1:' + info.port + '/rpc', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + info.desktopToken, 'Content-Type': 'application/json' },
      body,
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(await reply.text());
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: String(e) } }));
  }
}).listen(1431, '127.0.0.1');
const shutdown = () => {
  server.close();
  service.kill();
  setTimeout(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
    process.exit();
  }, 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
