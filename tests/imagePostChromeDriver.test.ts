import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { imagePostBrowserProfile } from '../src/imagePost/chromeDriver';

describe('image post Chrome driver', () => {
  it('opens the image editors in a dedicated profile and exposes no final-publish action', () => {
    expect(imagePostBrowserProfile('rednote').editorUrl).toContain('target=image');
    expect(imagePostBrowserProfile('wechat-image').editorUrl).toBe('https://mp.weixin.qq.com/');
    expect(imagePostBrowserProfile('rednote').terminalActionSelectors).toEqual([]);
    expect(imagePostBrowserProfile('wechat-image').terminalActionSelectors).toEqual([]);

    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/imagePost/chromeDriver.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('clickPublish');
    expect(source).not.toContain('正式发布');
  });

  it('enables the dedicated Chrome driver for Xiaohongshu first', () => {
    const main = fs.readFileSync(
      fileURLToPath(new URL('../src/studioMain.ts', import.meta.url)),
      'utf8',
    );
    expect(main).toContain("new DedicatedChromeImagePostDriver('rednote', imagePostChrome)");
    expect(main).toContain("new UnavailableImagePostBrowserDriver('微信贴图后台填充尚未启用。')");
  });
});
