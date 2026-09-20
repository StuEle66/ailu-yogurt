import fs from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DedicatedChromeController, imagePostBrowserProfile } from '../src/imagePost/chromeDriver';

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
