import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const mode = process.argv[2] || 'dev';
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status || 1);
};
run('cargo', ['build', '-p', 'vividiff-core', ...(mode === 'build' ? ['--release'] : [])]);
const target = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  .stdout.match(/host: (.+)/)[1]
  .trim();
mkdirSync('src-tauri/binaries', { recursive: true });
const ext = process.platform === 'win32' ? '.exe' : '';
copyFileSync(
  'target/' + (mode === 'build' ? 'release' : 'debug') + '/vividiff-cli' + ext,
  'src-tauri/binaries/vividiff-cli-' + target + ext,
);
run(process.execPath, [fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)), mode, ...process.argv.slice(3)]);
