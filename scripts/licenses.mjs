import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const npm = Object.entries(lock.packages)
  .filter(([path, p]) => path && !p.dev)
  .map(([path, p]) => ({
    name: path.split('node_modules/').at(-1),
    version: p.version,
    license: p.license || 'UNKNOWN',
    repository: p.repository?.url,
  }));
const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }),
);
const rust = metadata.packages
  .filter((p) => !metadata.workspace_members.includes(p.id))
  .map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license || 'SEE LICENSE FILE',
    repository: p.repository,
  }));
writeFileSync(
  'docs/THIRD_PARTY.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: 'Inventory includes transitive and target-specific Rust packages; not a legal opinion.',
      npm,
      rust,
    },
    null,
    2,
  ) + '\n',
);
const notices = new Map();
const add = (name, folder) => {
  if (!existsSync(folder)) return;
  for (const file of readdirSync(folder, { withFileTypes: true }).filter(
    (f) => f.isFile() && /^(LICENSE|COPYING|NOTICE)([.-].*)?$/i.test(f.name),
  )) {
    const content = readFileSync(join(folder, file.name), 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');
    const old = notices.get(hash);
    if (old) old.packages.push(name + ' / ' + file.name);
    else notices.set(hash, { packages: [name + ' / ' + file.name], content });
  }
};
for (const [path, p] of Object.entries(lock.packages))
  if (path && !p.dev) add(path.split('node_modules/').at(-1) + '@' + p.version, path);
for (const p of metadata.packages)
  if (!metadata.workspace_members.includes(p.id))
    add(p.name + '@' + p.version, dirname(p.manifest_path));
writeFileSync(
  'docs/THIRD_PARTY_NOTICES.txt',
  [...notices.values()]
    .map(
      (n) =>
        '='.repeat(72) + '\n' + n.packages.join('\n') + '\n' + '='.repeat(72) + '\n\n' + n.content,
    )
    .join('\n\n'),
);
console.log(
  'Inventoried ' +
    npm.length +
    ' npm and ' +
    rust.length +
    ' Rust packages; collected ' +
    notices.size +
    ' unique notice files',
);
