import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { COMMAND_IDS, VIEW_IDS } from '../src/ids';

function source(relativePath: string): string {
  return fs.readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf8',
  );
}

describe('creator studio naming', () => {
  test('renames the publishing workspace without changing its compatible ids or platform draft terms', () => {
    const chrome = source('src/ui/studioChrome.ts');
    const main = source('src/studioMain.ts');
    const studio = source('src/ui/publishingStudioView.ts');
    const settings = source('src/ui/settingsTab.ts');

    expect(chrome).toContain("label: '创作台'");
    expect(main).toContain("name: '打开创作台'");
    expect(studio).toContain("'aria-label': '打开创作台设置'");
    expect(studio).toContain("'创作台会自动跟随当前笔记。'");
    expect(studio).toContain("'aria-label': '创作台目标'");
    expect(settings).toContain("{ id: 'publishing', label: '创作台' }");

    expect(VIEW_IDS.publishing).toBe('ailu-publishing');
    expect(COMMAND_IDS.openPublishing).toBe('open-publishing-workbench');
    expect(settings).toContain(".setName('公众号草稿')");
    expect(settings).toContain(".setName('X Article 草稿')");
    expect(studio).toContain("'上传到草稿箱'");
    expect(studio).toContain("text: '创建 X 草稿'");
  });
});
