import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const task =
  process.platform === 'linux'
    ? 'package:linux'
    : process.platform === 'win32'
      ? 'package:windows'
      : '';
if (!task) {
  throw Error('Desktop packaging supports Windows and Linux.');
}
const require = createRequire(import.meta.url);
const turbo = path.join(path.dirname(require.resolve('turbo/package.json')), 'bin/turbo');
const result = spawnSync(process.execPath, [turbo, 'run', task, '--filter=@wisp/desktop'], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
