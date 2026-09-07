import fs from 'node:fs';
import crypto from 'node:crypto';
import { describe, expect, test } from 'vitest';

const fontArtifacts = [
  'assets/fonts/MaShanZheng-Regular.woff2',
  'assets/fonts/MaShanZheng-OFL.txt',
  'assets/fonts/ZCOOLKuaiLe-Regular.ttf',
  'assets/fonts/ZCOOLKuaiLe-OFL.txt',
];

describe('offline Rednote release contract', () => {
  test('ships the unchanged MDFlow font files with their original OFL notices', () => {
    const hashes = [
      'b9d416b65858c92f31b4447d119bec2ef31c883f0764604f353c3a641f156dcb',
      '18aabf190848725e2576eefb5c29ba06aac1029d02132252a7f312eac2e50cf3',
      'bc218a547914684c036e0e141bdc60fd94e5fbe22eb84e1f4d1859875fc2415b',
      '91ef06981e715027e93a66e95fe827db07c4c959dbca164489509febc0dfe400',
    ];
    for (const [index, artifact] of fontArtifacts.entries()) {
      expect(fs.existsSync(artifact), `Missing distribution asset ${artifact}`).toBe(true);
      expect(crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')).toBe(hashes[index]);
    }
  });
  test('build attestation, release verification and deployment include both fonts and their licenses', () => {
    for (const script of ['scripts/build-release.mjs', 'scripts/verify-release.mjs', 'scripts/deploy-ailu.mjs']) {
      const source = fs.readFileSync(script, 'utf8');
      for (const artifact of fontArtifacts) expect(source, `${script} must carry ${artifact}`).toContain(artifact);
    }
  });
});
