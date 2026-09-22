import fs from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildWechatImageComposerUrl,
  classifyImagePostComposerSnapshot,
  CdpSession,
  DedicatedChromeController,
  DedicatedChromeImagePostDriver,
  imagePostBrowserProfile,
  planImagePostUploadBatches,
  selectWechatImageComposerTarget,
  selectExistingImagePostTarget,
  waitForImagePostComposerState,
  waitForStableUploadedImageCount,
  waitForUploadedImageCount,
} from '../src/imagePost/chromeDriver';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('image post Chrome driver', () => {
  it('waits for a delayed authenticated home page before opening the WeChat image composer', async () => {
    const homeUrl = 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=test';
    const composerUrl = buildWechatImageComposerUrl(homeUrl);
    let homeReads = 0;
    const session = (url: string) => ({
      close: vi.fn(),
      isHealthy: vi.fn(async () => true),
      send: vi.fn(async (method: string) => method === 'Runtime.evaluate'
        ? { result: { value: {
          url: url === 'home' ? (++homeReads < 2 ? 'about:blank' : homeUrl) : composerUrl,
          readyState: url === 'home' && homeReads < 3 ? 'loading' : 'complete',
          text: '', fileInputCount: url === 'home' ? 0 : 2,
          uploadedImageCount: 0, hasTitle: url !== 'home', hasBody: url !== 'home',
          hasContent: false, title: '', body: '',
        } } }
        : {}),
    });
    const chrome = {
      openPage: vi.fn(async (url: string) => session(url === 'https://mp.weixin.qq.com/' ? 'home' : 'composer')),
    };
    const driver = new DedicatedChromeImagePostDriver(
      'wechat-image', chrome as unknown as DedicatedChromeController,
    );

    await driver.openEditor('wechat-image', new AbortController().signal);
    expect(chrome.openPage).toHaveBeenCalledWith(composerUrl, expect.any(AbortSignal));
    expect(homeReads).toBe(3);
    await expect(driver.inspectEditor(new AbortController().signal)).resolves.toBe('empty');
  });

  it('reconnects once before upload when an old WeChat tab loses its CDP connection', async () => {
    const homeUrl = 'https://mp.weixin.qq.com/cgi-bin/home?token=test';
    const composerUrl = buildWechatImageComposerUrl(homeUrl);
    const disconnected = {
      close: vi.fn(), isHealthy: vi.fn(async () => false),
      send: vi.fn(async (method: string) => {
        if (method === 'Runtime.evaluate') throw new Error('专用 Chrome 连接已断开。');
        return {};
      }),
    };
    const healthy = (url: string) => ({
      close: vi.fn(), isHealthy: vi.fn(async () => true),
      send: vi.fn(async (method: string) => method === 'Runtime.evaluate'
        ? { result: { value: {
          url, text: '', fileInputCount: url === homeUrl ? 0 : 2,
          uploadedImageCount: 0, hasTitle: url !== homeUrl, hasBody: url !== homeUrl,
          hasContent: false, title: '', body: '',
        } } } : {}),
    });
    const chrome = { openPage: vi.fn()
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce(healthy(homeUrl))
      .mockResolvedValueOnce(healthy(composerUrl!)) };
    const driver = new DedicatedChromeImagePostDriver('wechat-image', chrome as unknown as DedicatedChromeController);
    await driver.openEditor('wechat-image', new AbortController().signal);
    expect(chrome.openPage).toHaveBeenCalledTimes(3);
    expect(disconnected.close).toHaveBeenCalledOnce();
    await expect(driver.inspectEditor(new AbortController().signal)).resolves.toBe('empty');
  });

  it('treats an existing WeChat image composer with content as occupied and never opens another page', async () => {
    const composerUrl = buildWechatImageComposerUrl('https://mp.weixin.qq.com/cgi-bin/home?token=test');
    const chrome = { openPage: vi.fn(async () => ({
      close: vi.fn(), isHealthy: vi.fn(async () => true),
      send: vi.fn(async (method: string) => method === 'Runtime.evaluate'
        ? { result: { value: {
          url: composerUrl, text: '', fileInputCount: 2, uploadedImageCount: 1,
          hasTitle: true, hasBody: true, hasContent: true, title: '已有标题', body: '已有正文',
        } } } : {}),
    })) };
    const driver = new DedicatedChromeImagePostDriver('wechat-image', chrome as unknown as DedicatedChromeController);
    await driver.openEditor('wechat-image', new AbortController().signal);
    await expect(driver.inspectEditor(new AbortController().signal)).resolves.toBe('content-present');
    expect(chrome.openPage).toHaveBeenCalledTimes(1);
  });

  it('stops at the WeChat login page without opening a composer or uploading', async () => {
    const chrome = { openPage: vi.fn(async () => ({
      close: vi.fn(), isHealthy: vi.fn(async () => true),
      send: vi.fn(async (method: string) => method === 'Runtime.evaluate'
        ? { result: { value: {
          url: 'https://mp.weixin.qq.com/', text: '扫码登录', fileInputCount: 0,
          uploadedImageCount: 0, hasTitle: false, hasBody: false,
          hasContent: false, title: '', body: '',
        } } } : {}),
    })) };
    const driver = new DedicatedChromeImagePostDriver('wechat-image', chrome as unknown as DedicatedChromeController);
    const stages: string[] = [];
    await driver.openEditor('wechat-image', new AbortController().signal, stage => stages.push(stage));
    await expect(driver.inspectEditor(new AbortController().signal)).resolves.toBe('login-required');
    expect(chrome.openPage).toHaveBeenCalledTimes(1);
    expect(stages).toEqual(['connecting-browser', 'waiting-home']);
  });

  it('ends an unrecognized WeChat home page wait within the opening deadline', async () => {
    vi.useFakeTimers();
    const chrome = { openPage: vi.fn(async () => ({
      close: vi.fn(), isHealthy: vi.fn(async () => true),
      send: vi.fn(async (method: string) => method === 'Runtime.evaluate'
        ? { result: { value: {
          url: 'about:blank', text: '', fileInputCount: 0, uploadedImageCount: 0,
          hasTitle: false, hasBody: false, hasContent: false, title: '', body: '',
        } } } : {}),
    })) };
    const driver = new DedicatedChromeImagePostDriver('wechat-image', chrome as unknown as DedicatedChromeController);
    const operation = driver.openEditor('wechat-image', new AbortController().signal);
    const assertion = expect(operation).rejects.toThrow('微信主页加载超时');
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    expect(chrome.openPage).toHaveBeenCalledTimes(1);
  });
  it('opens the authenticated WeChat image composer directly from the home-page token', () => {
    expect(buildWechatImageComposerUrl(
      'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=test-token',
    )).toBe(
      'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media%2Fappmsg_edit_v2&action=edit&isNew=1&type=77&createType=8&token=test-token&lang=zh_CN',
    );
    expect(buildWechatImageComposerUrl('https://mp.weixin.qq.com/')).toBeNull();
  });

  it('submits WeChat photos as one ordered multi-select batch', () => {
    expect(planImagePostUploadBatches('wechat-image', ['/a.jpg', '/b.png', '/c.webp']))
      .toEqual([['/a.jpg', '/b.png', '/c.webp']]);
  });

  it('keeps Xiaohongshu uploads sequential', () => {
    expect(planImagePostUploadBatches('rednote', ['/a.jpg', '/b.png', '/c.webp']))
      .toEqual([['/a.jpg'], ['/b.png'], ['/c.webp']]);
  });

  it('ends a CDP command that never returns instead of staying busy forever', async () => {
    class SilentWebSocket extends EventTarget {
      constructor(_url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      close(): void {}
      send(_payload: string): void {}
    }
    vi.stubGlobal('WebSocket', SilentWebSocket);
    const session = await CdpSession.connect(
      'ws://127.0.0.1/devtools/page/test',
      new AbortController().signal,
      { connectTimeoutMs: 50, commandTimeoutMs: 20 },
    );

    await expect(session.send('Runtime.evaluate')).rejects.toThrow('Chrome 调用超时');
  });

  it('ends a WebSocket connection attempt that never opens', async () => {
    class NeverOpeningWebSocket extends EventTarget {
      constructor(_url: string) { super(); }
      close(): void {}
      send(_payload: string): void {}
    }
    vi.stubGlobal('WebSocket', NeverOpeningWebSocket);

    await expect(CdpSession.connect(
      'ws://127.0.0.1/devtools/page/test',
      new AbortController().signal,
      { connectTimeoutMs: 20, commandTimeoutMs: 50 },
    )).rejects.toThrow('连接专用 Chrome 超时');
  });

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

  it('allows a slow platform editor to mount without reporting a page change too early', async () => {
    let reads = 0;

    await expect(waitForImagePostComposerState(
      async () => reads++ < 25 ? 'page-changed' : 'empty',
      async () => undefined,
    )).resolves.toBe('empty');
    expect(reads).toBe(26);
  });

  it('polls until every selected image appears in the backend editor', async () => {
    const counts = [0, 1, 2];
    let reads = 0;
    let waits = 0;

    await expect(waitForUploadedImageCount(
      async () => counts[Math.min(reads++, counts.length - 1)],
      async () => { waits += 1; },
      2,
    )).resolves.toBe(true);
    expect(reads).toBe(3);
    expect(waits).toBe(2);
  });

  it('does not accept a transient client-side thumbnail as a completed upload', async () => {
    const counts = [0, 1, 2, 2, 1, 1, 1];
    let reads = 0;

    await expect(waitForStableUploadedImageCount(
      async () => counts[Math.min(reads++, counts.length - 1)],
      async () => undefined,
      2,
      7,
      3,
    )).resolves.toBe(false);
  });

  it('accepts the expected backend image count only after it stays stable', async () => {
    const counts = [0, 1, 2, 2, 2];
    let reads = 0;

    await expect(waitForStableUploadedImageCount(
      async () => counts[Math.min(reads++, counts.length - 1)],
      async () => undefined,
      2,
      7,
      3,
    )).resolves.toBe(true);
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

  it('does not reuse the WeChat home page when the image composer URL is requested', () => {
    expect(selectExistingImagePostTarget([
      {
        type: 'page',
        url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=test',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/home',
      },
    ], 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&type=77&token=test')).toBeNull();
  });

  it('opens the current WeChat image-post editor without relying on a pointer click', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/imagePost/chromeDriver.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('buildWechatImageComposerUrl(snapshot.url)');
    expect(source).not.toContain("'Input.dispatchMouseEvent'");
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
    expect(profile.titleSelectors[0]).toBe('[data-placeholder*="标题"].ProseMirror[contenteditable="true"]');
    expect(profile.bodySelectors[0]).toBe('.share-text__input .ProseMirror');
    expect(profile.uploadedImageSelector).toBe('.image-selector__bottom-list-item');
  });

  it('counts only Xiaohongshu upload thumbnails instead of duplicate preview images', () => {
    expect(imagePostBrowserProfile('rednote').uploadedImageSelector).toBe('img.img.preview');
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
