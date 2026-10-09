import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed (${result.status})`);
  return (result.stdout || '').trim();
}

run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
const remotes = run('git', ['remote'], root, true).split('\n');
const remote = process.argv[2] || (remotes.includes('publish') ? 'publish' : 'origin');
const url = run('git', ['remote', 'get-url', remote], root, true);
const existing = run('git', ['ls-remote', '--heads', url, 'gh-pages'], root, true);
const temporary = mkdtempSync(join(tmpdir(), 'kart-pages-'));
try {
  if (existing) run('git', ['clone', '--depth', '1', '--branch', 'gh-pages', url, temporary]);
  else {
    run('git', ['init', '-b', 'gh-pages'], temporary);
    run('git', ['remote', 'add', 'origin', url], temporary);
  }
  for (const name of readdirSync(temporary)) {
    if (name !== '.git') rmSync(join(temporary, name), { recursive: true, force: true });
  }
  cpSync(join(root, 'dist'), temporary, { recursive: true });
  writeFileSync(join(temporary, '.nojekyll'), '');
  run('git', ['add', '-A'], temporary);
  const changes = run('git', ['diff', '--cached', '--name-only'], temporary, true);
  if (changes) {
    run('git', ['-c', 'user.name=Chinese Can Fly Kart Publisher', '-c', 'user.email=157134553+CCCIRCCCLE715@users.noreply.github.com', 'commit', '-m', 'Publish browser game'], temporary);
    run('git', ['push', 'origin', 'gh-pages'], temporary);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
