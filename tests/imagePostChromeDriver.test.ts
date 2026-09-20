import fs from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyImagePostComposerSnapshot,
  DedicatedChromeController,
  imagePostBrowserProfile,
  selectWechatImageComposerTarget,
  selectExistingImagePostTarget,
  waitForImagePostComposerState,
  WECHAT_IMAGE_COMPOSER_ENTRY_SELECTOR,
  WECHAT_IMAGE_COMPOSER_LABELS,
} from '../src/imagePost/chromeDriver';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('allows only the Obsidian app origin to control the dedicated Chrome session', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/imagePost/chromeDriver.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("'--remote-allow-origins=app://obsidian.md'");
    expect(source).not.toContain("'--remote-allow-origins=*'");
  });

  it('recognizes the logged-in Xiaohongshu image upload entry before title fields appear', () => {
    expect(classifyImagePostComposerSnapshot({
      url: imagePostBrowserProfile('rednote').editorUrl,
      text: '上传图文\n上传图片\n支持 png、jpg、jpeg、webp',
      fileInputCount: 1,
      uploadedImageCount: 0,
      hasTitle: false,
      hasBody: false,
      hasContent: false,
    })).toBe('empty');
  });

  it('recognizes the WeChat QR login page before looking for editor controls', () => {
    expect(classifyImagePostComposerSnapshot({
      url: 'https://mp.weixin.qq.com/',
      text: '微信公众平台\n使用账号登录\n扫码登录',
      fileInputCount: 0,
      uploadedImageCount: 0,
      hasTitle: false,
      hasBody: false,
      hasContent: false,
    })).toBe('login-required');
  });

  it('waits for a newly opened image editor to finish mounting its controls', async () => {
    const states = ['page-changed', 'page-changed', 'empty'] as const;
    let reads = 0;
    let waits = 0;

    await expect(waitForImagePostComposerState(
      async () => states[Math.min(reads++, states.length - 1)],
      async () => { waits += 1; },
    )).resolves.toBe('empty');
    expect(reads).toBe(3);
    expect(waits).toBe(2);
  });

  it('reuses the existing authenticated platform tab instead of opening a duplicate', () => {
    expect(selectExistingImagePostTarget([
      {
        type: 'page',
        url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=test',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/authenticated',
      },
      {
        type: 'page',
        url: 'https://mp.weixin.qq.com/',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/login',
      },
      {
        type: 'page',
        url: 'https://example.com/',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/unrelated',
      },
    ], imagePostBrowserProfile('wechat-image').editorUrl)).toEqual({
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/authenticated',
    });
  });

  it('follows the WeChat image composer opened from the home page', () => {
    expect(selectWechatImageComposerTarget([
      {
        type: 'page',
        url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=test',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/home',
      },
      {
        type: 'page',
        url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&createType=8&token=test',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/image-composer',
      },
      {
        type: 'page',
        url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&type=10&token=test',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/article-composer',
      },
    ])).toEqual({
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/image-composer',
    });
  });

  it('recognizes the current WeChat image-post entry label', () => {
    expect(WECHAT_IMAGE_COMPOSER_LABELS).toContain('贴图');
    expect(WECHAT_IMAGE_COMPOSER_ENTRY_SELECTOR).toContain('.new-creation__menu-item');
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/imagePost/chromeDriver.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("'Input.dispatchMouseEvent'");
  });

  it('treats the WeChat description placeholder as an empty composer', () => {
    expect(classifyImagePostComposerSnapshot({
      url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&type=77',
      text: '选择或拖拽图片\n填写描述信息，让大家了解更多内容',
      fileInputCount: 2,
      uploadedImageCount: 0,
      hasTitle: true,
      hasBody: true,
      hasContent: true,
      title: '',
      body: '填写描述信息，让大家了解更多内容',
    })).toBe('empty');
  });

  it('targets the WeChat image-post uploader and description editor instead of article controls', () => {
    const profile = imagePostBrowserProfile('wechat-image');
    expect(profile.fileInputSelector).toBe('.js_upload_btn_container input[type="file"]');
    expect(profile.bodySelectors[0]).toBe('.share-text__input .ProseMirror');
    expect(profile.uploadedImageSelector).toBe('.image-selector__bottom-list-item');
  });

  it('enables the dedicated Chrome driver for both image-post editors', () => {
    const main = fs.readFileSync(
      fileURLToPath(new URL('../src/studioMain.ts', import.meta.url)),
      'utf8',
    );
    expect(main).toContain("new DedicatedChromeImagePostDriver('rednote', imagePostChrome)");
    expect(main).toContain("new DedicatedChromeImagePostDriver('wechat-image', imagePostChrome)");
  });

  it('opens an existing local Chrome endpoint when renderer fetch is unavailable', async () => {
    const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'ailu-chrome-driver-'));
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/json/version') {
        response.end('{"Browser":"Chrome/Test"}');
        return;
      }
      if (request.method === 'PUT' && request.url?.startsWith('/json/new?')) {
        response.end('{"webSocketDebuggerUrl":"ws://127.0.0.1/devtools/page/test"}');
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务器未监听 TCP 端口。');
    await writeFile(path.join(profileDirectory, 'DevToolsActivePort'), `${address.port}\n/devtools/browser/test\n`, 'utf8');

    class TestWebSocket extends EventTarget {
      constructor(_url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      close(): void {}
      send(_payload: string): void {}
    }
    vi.stubGlobal('fetch', vi.fn(() => { throw new TypeError('renderer fetch blocked'); }));
    vi.stubGlobal('WebSocket', TestWebSocket);

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 500);
    try {
      await expect(new DedicatedChromeController(profileDirectory, '/usr/bin/true')
        .openPage('https://example.com/editor', abort.signal)).resolves.toBeDefined();
    } finally {
      clearTimeout(timeout);
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(profileDirectory, { recursive: true, force: true });
    }
  });
});
