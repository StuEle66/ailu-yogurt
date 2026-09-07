import {
  assertExactPublicInventory,
  assertExactGitIndexState,
  assertPublicText,
  verifyPublicSourceTree,
} from './public-source-policy.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function verifyFixture(relativePath, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-public-policy-'));
  try {
    const files = [relativePath, 'public-source-files.json', 'scripts/public-source-policy.mjs', 'scripts/test-public-source-policy.mjs']
      .sort((left, right) => left.localeCompare(right));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content);
    fs.writeFileSync(path.join(root, 'public-source-files.json'), JSON.stringify({ schema_version: 1, files }));
    for (const script of ['public-source-policy.mjs', 'test-public-source-policy.mjs']) {
      fs.writeFileSync(path.join(root, 'scripts', script), '// Synthetic public policy fixture.\n');
    }
    execFileSync('git', ['init', '--quiet', root]);
    execFileSync('git', ['add', '--all'], { cwd: root });
    return verifyPublicSourceTree(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

verifyFixture('AGENTS.md', '# Public project rules\nPreserve licenses and test changes.\n');
for (const nestedPath of ['docs/AGENTS.md', 'src/agents.md', 'agents.md']) {
  expectFailure(
    () => verifyFixture(nestedPath, '# Private workspace instructions\n'),
    'Only the exact root AGENTS.md may enter the public tree.',
  );
}
expectFailure(
  () => verifyFixture('AGENTS.md', ['Local path: ', '', 'Users', 'private-user', 'Vault'].join('/')),
  'Root AGENTS.md must still reject personal home paths.',
);
expectFailure(
  () => verifyFixture('AGENTS.md', ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')),
  'Root AGENTS.md must still reject private-key material.',
);

function expectFailure(operation, message) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(message);
}

assertExactPublicInventory(
  ['README.md', 'src/main.ts'],
  ['README.md', 'src/main.ts'],
);
expectFailure(
  () => assertExactPublicInventory(
    ['README.md', 'src/main.ts'],
    ['README.md', 'src/main.ts', 'src/renamed-private.ts'],
  ),
  'An unreviewed renamed file must fail the public inventory.',
);
expectFailure(
  () => assertExactPublicInventory(
    ['README.md', 'assets/ailu-ribbon-icon.png'],
    ['README.md', 'assets/ailu-ribbon-icon.png', 'assets/unknown.bin'],
  ),
  'An unknown binary must fail the public inventory.',
);
expectFailure(
  () => assertExactPublicInventory(['README.md'], ['README.md', 'src/link.ts']),
  'A symlink-shaped unexpected entry must fail before publication.',
);
expectFailure(
  () => assertPublicText(
    'README.md',
    `Local path: ${['', 'Users', 'private-user', 'Vault'].join('/')}`,
  ),
  'A personal home path must fail the public content policy.',
);
expectFailure(
  () => assertPublicText(
    'tests/leak.test.ts',
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  ),
  'Private-key material must fail even inside tests.',
);
expectFailure(
  () => assertPublicText(
    'src/leak.ts',
    ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz123456'].join(''),
  ),
  'A GitHub token must fail the public content policy.',
);
expectFailure(
  () => assertPublicText(
    'src/leak.ts',
    ['auth_token=', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'].join(''),
  ),
  'A live-looking X cookie must fail the public content policy.',
);
assertPublicText('tests/example.test.ts', 'Synthetic path: /Users/example/Vault');

assertExactGitIndexState(
  ['README.md', 'src/main.ts'],
  [
    { mode: '100644', stage: '0', path: 'README.md' },
    { mode: '100644', stage: '0', path: 'src/main.ts' },
  ],
  true,
);
expectFailure(
  () => assertExactGitIndexState(
    ['README.md'],
    [{ mode: '100644', stage: '0', path: 'README.md' }],
    false,
  ),
  'A staged blob that differs from the reviewed working tree must fail.',
);
expectFailure(
  () => assertExactGitIndexState(
    ['README.md'],
    [{ mode: '120000', stage: '0', path: 'README.md' }],
    true,
  ),
  'A staged symlink must fail the public index policy.',
);
expectFailure(
  () => assertExactGitIndexState(
    ['README.md'],
    [{ mode: '100644', stage: '1', path: 'README.md' }],
    true,
  ),
  'An unmerged staged entry must fail the public index policy.',
);

process.stdout.write('Verified public source policy self-tests.\n');
