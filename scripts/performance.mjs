// A small reproducible JS diff benchmark, separate from correctness tests.
import { diffLines } from 'diff';
import { writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
const before = Array.from({ length: 100000 }, (_, i) => 'line ' + i).join('\n') + '\n';
const after = before.replace('line 50000\n', 'changed 50000\n') + 'last\n';
const samples = [];
for (let n = 0; n < 5; n++) {
  const start = performance.now();
  const result = diffLines(before, after, { timeout: 2000, maxEditLength: 20000 });
  samples.push({
    milliseconds: Math.round((performance.now() - start) * 100) / 100,
    parts: result?.length,
  });
}
const report = {
  platform: platform() + ' ' + release(),
  cpu: cpus()[0].model,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  node: process.version,
  lines: 100000,
  bytes: Buffer.byteLength(before),
  samples,
};
writeFileSync('docs/PERFORMANCE.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
