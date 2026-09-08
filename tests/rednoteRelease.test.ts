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
  test('keeps the workbench inside its publishing grid column', () => {
    const styles = fs.readFileSync('styles.css', 'utf8');
    const shellRule = styles.match(/\.ailu-publishing-shell\s*\{([^}]*)\}/)?.[1] ?? '';
    const panelRule = styles.match(/\.ailu-rednote-panel\.ailu-rednote-scope\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(shellRule).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(shellRule).toContain('min-width: 0;');
    expect(panelRule).toContain('width: 100%;');
    expect(panelRule).toContain('max-width: 100%;');
    expect(panelRule).toContain('overflow: hidden;');
  });

  test('keeps export controls clear of Obsidian status bar', () => {
    const styles = fs.readFileSync('styles.css', 'utf8');
    const panel = fs.readFileSync('src/ui/redNotePublishingPanel.ts', 'utf8');
    expect(styles).toContain('padding: 8px 10px calc(8px + var(--ailu-rednote-safe-bottom));');
    expect(styles).not.toMatch(/\.ailu-rednote-panel\.ailu-rednote-scope\s*\{[^}]*padding-bottom:\s*56px;/);
    expect(panel).toContain("document.querySelector<HTMLElement>('.status-bar')");
    expect(panel).toContain('redNoteStatusBarInset(viewport.getBoundingClientRect()');
  });

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
