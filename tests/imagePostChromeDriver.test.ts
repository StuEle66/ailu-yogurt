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
});
