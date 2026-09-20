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
const targetActivity = fs.readFileSync(
  fileURLToPath(new URL('../src/ui/publishingTargetActivity.ts', import.meta.url)),
  'utf8',
);

describe('image post creator studio', () => {
  it('shows cards and photo drafts as separate first-class creator targets', () => {
    expect(targetActivity).toContain("{ id: 'rednote', label: '小红书图卡' }");
    expect(targetActivity).toContain("{ id: 'image-post', label: '图文草稿' }");
    expect(studio).not.toContain("'小红书图卡将跟随当前文章。'");
    expect(studio).toContain("text: '图文草稿 · 小红书 / 微信贴图'");
  });

  it('offers direct Xiaohongshu, direct WeChat, and parallel handoff actions', () => {
    expect(imagePostPanel).toContain("'填入小红书'");
    expect(imagePostPanel).toContain("'填入微信贴图'");
    expect(imagePostPanel).toContain("'双平台填入'");
    expect(imagePostPanel).not.toContain("text: '填入所选后台'");
  });

  it('embeds a read-only card preview without allowing cards into the photo draft', () => {
    expect(imagePostPanel).toContain('await this.cards.render(root)');
    expect(imagePostPanel).not.toContain('加入当前 Markdown 图卡');
    expect(imagePostPanel).not.toContain('materializeCards');
  });
});
