// A non-Git read-only provider proving the protocol has no Git-specific IDs.
// repo is a directory containing before.txt and after.txt.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.once('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
    const p = req.params || {};
    let result;
    switch (req.method) {
      case 'initialize':
        result = { protocolVersion: 1, id: 'fixture', capabilities: ['revisions'] };
        break;
      case 'getCapabilities':
        result = { index: false, worktree: false, mergeBase: false };
        break;
      case 'detectRepository':
        result = { root: p.repo };
        break;
      case 'resolveRevision':
        result = { revision: p.revision };
        break;
      case 'listRevisions':
        result = {
          items: [
            { id: 'before', label: 'Before fixture' },
            { id: 'after', label: 'After fixture' },
          ],
          nextOffset: 0,
        };
        break;
      case 'listChanges': {
        const read = (name) => {
          if (!['before', 'after'].includes(name)) throw Error('Unknown fixture revision');
          const text = readFileSync(join(p.repo, name + '.txt'), 'utf8');
          return {
            kind: 'text',
            text,
            size: Buffer.byteLength(text),
            hash: createHash('sha256').update(text).digest('hex'),
          };
        };
        result = {
          provider: 'fixture',
          left: p.left,
          right: p.right,
          files: [
            {
              path: 'fixture.txt',
              oldPath: 'fixture.txt',
              status: 'M',
              left: read(p.left),
              right: read(p.right),
            },
          ],
        };
        break;
      }
      default:
        throw Error('METHOD_NOT_FOUND');
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
  } catch (e) {
    console.log(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req?.id,
        error: { code: 'FIXTURE_ERROR', message: String(e) },
      }),
    );
  }
  rl.close();
});
