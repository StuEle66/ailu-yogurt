import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const studio = fs.readFileSync(
  fileURLToPath(new URL('../src/ui/publishingStudioView.ts', import.meta.url)),
  'utf8',
);
const imagePostPanel = fs.readFileSync(
  fileURLToPath(new URL('../src/ui/imagePostPublishingPanel.ts', import.meta.url)),
  'utf8',
);

describe('image post creator studio', () => {
  it('keeps the image-post workspace available without an open Markdown note', () => {
    expect(studio).toContain('ensureImagePostPanel');
    expect(studio).not.toContain("'小红书图卡将跟随当前文章。'");
    expect(studio).toContain("text: '图文 · 小红书 / 微信贴图'");
  });

  it('offers direct Xiaohongshu, direct WeChat, and parallel handoff actions', () => {
    expect(imagePostPanel).toContain("'填入小红书'");
    expect(imagePostPanel).toContain("'填入微信贴图'");
    expect(imagePostPanel).toContain("'双平台填入'");
    expect(imagePostPanel).not.toContain("text: '填入所选后台'");
  });
});
