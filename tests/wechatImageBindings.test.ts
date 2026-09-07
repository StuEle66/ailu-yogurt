import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { App, Component } from 'obsidian';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  MarkdownRenderer: {
    async render(_app: unknown, markdown: string, container: HTMLElement) {
      // Obsidian is the external rendering boundary; preserve each image occurrence.
      // Synthetic Obsidian boundary fixture, never mounted in a browser.
      // eslint-disable-next-line no-unsanitized/property -- inert detached markup, never mounted
      container.innerHTML = '<h2>正文</h2>' + [...markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)]
        .map(([, alt, src]) => `<p><img alt="${alt}" src="${src}"></p>`).join('');
    },
  },
  sanitizeHTMLToDom(html: string) {
    const template = document.createElement('template');
    // eslint-disable-next-line no-unsanitized/property -- inert test fixture
    template.innerHTML = html;
    return template.content;
  },
}));

import { normalizeWeChatPublishingImages } from '../src/wechat/imageBindings';
import { prepareSnapshotForPublishing } from '../src/publishing/fromSnapshot';
import { buildPreparedArticleClipboardPayload } from '../src/publishing/preparedArticleBuilder';
import { renderWeChatArticle } from '../src/wechat/renderer';
import type { WeChatPreviewSnapshot } from '../src/wechat/types';
import { onePixelJpeg, onePixelPng } from './fixtures/imageBytes';

function snapshot(): WeChatPreviewSnapshot {
  const body = onePixelJpeg();
  return {
    sourcePath: '文章/示例.md', title: '示例', author: '', digest: '', contentSourceUrl: '',
    markdown: '## 正文\n![本地图](ailu-asset://local)\n![本地图](ailu-asset://local)',
    contentHash: 'snapshot', warnings: [], thumbMediaId: '', coverAssetToken: null,
    rendererVersion: 'ailu-wechat-v2',
    assets: [{ token: 'ailu-asset://local', source: '图片.jpeg', fileName: '图片.jpeg',
      mimeType: 'image/jpeg', body, previewUrl: '',
      contentHash: createHash('sha256').update(Buffer.from(body)).digest('hex') }],
  };
}

function component(): Component {
  return { register() {} } as unknown as Component;
}

describe('WeChat preview image identity', () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM('<!doctype html>');
    vi.stubGlobal('document', dom.window.document);
    Object.defineProperty(dom.window.HTMLElement.prototype, 'empty', {
      value(this: HTMLElement) { this.replaceChildren(); }, configurable: true,
    });
    let sequence = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:app://runtime-preview-${++sequence}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); });

  test('returns the frozen identity of a displayed local image without changing the snapshot', async () => {
    const frozen = snapshot();
    const before = JSON.stringify(frozen);
    const container = document.createElement('article');
    const result = await renderWeChatArticle({} as App, component(), frozen, container);
    const binding = result as unknown as { imageBindings?: ReadonlyMap<string, string> } | undefined;
    expect(binding?.imageBindings?.get(container.querySelector('img')!.getAttribute('src')!))
      .toBe('ailu-asset://local');
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  test('copies rendered frozen JPEG bytes instead of temporary preview URLs', async () => {
    const frozen = snapshot();
    const container = document.createElement('article');
    const { imageBindings } = await renderWeChatArticle({} as App, component(), frozen, container);
    const liveHtml = container.innerHTML;
    const html = normalizeWeChatPublishingImages(liveHtml, imageBindings);
    const article = await prepareSnapshotForPublishing(frozen, html);
    const clipboard = buildPreparedArticleClipboardPayload(article);
    expect(clipboard.html).toContain('data:image/jpeg;base64,');
    expect(clipboard.html).not.toMatch(/blob:|ailu-asset:|ailu-prepared-image:/);
    expect(clipboard.html.match(/<img /g)).toHaveLength(1);
    expect(container.innerHTML).toBe(liveHtml);
  });


  test('rejects unknown blob URLs even when their basename matches a frozen file', async () => {
    const container = document.createElement('article');
    const { imageBindings } = await renderWeChatArticle({} as App, component(), snapshot(), container);
    expect(() => normalizeWeChatPublishingImages('<img src="blob:app://foreign/图片.jpeg">', imageBindings))
      .toThrow('正文图片未通过本地预检');
  });


  test('rejects an old preview URL against the refreshed render bindings', async () => {
    const owner = component();
    const container = document.createElement('article');
    await renderWeChatArticle({} as App, owner, snapshot(), container);
    const previous = container.innerHTML;
    const current = await renderWeChatArticle({} as App, owner, snapshot(), container);
    expect(() => normalizeWeChatPublishingImages(previous, current.imageBindings))
      .toThrow('正文图片未通过本地预检');
    expect(() => normalizeWeChatPublishingImages(container.innerHTML, current.imageBindings)).not.toThrow();
  });

  test('preserves remote/local image order and repetition through the final clipboard', async () => {
    const frozen = snapshot();
    const body = onePixelPng();
    frozen.assets.push({ token: 'ailu-asset://remote', source: 'https://example.test/remote.png',
      fileName: 'remote.png', mimeType: 'image/png', body, previewUrl: '',
      contentHash: createHash('sha256').update(Buffer.from(body)).digest('hex') });
    frozen.markdown = '![封面](ailu-asset://local)\n![远程](ailu-asset://remote)\n![本地](ailu-asset://local)\n![远程重复](ailu-asset://remote)';
    const container = document.createElement('article');
    const { imageBindings } = await renderWeChatArticle({} as App, component(), frozen, container);
    const article = await prepareSnapshotForPublishing(frozen,
      normalizeWeChatPublishingImages(container.innerHTML, imageBindings));
    const clipboard = buildPreparedArticleClipboardPayload(article);
    const parsed = document.createElement('template');
    // eslint-disable-next-line no-unsanitized/property -- inert test assertions
    parsed.innerHTML = clipboard.html;
    expect([...parsed.content.querySelectorAll('img')].map(image => image.getAttribute('src')?.split(';')[0]))
      .toEqual(['data:image/png', 'data:image/jpeg', 'data:image/png']);
    expect(clipboard.html).not.toMatch(/blob:|ailu-asset:|ailu-prepared-image:/);
  });

  test('does not expose a mutable binding Map or normalize arbitrary text and links', async () => {
    const container = document.createElement('article');
    const result = await renderWeChatArticle({} as App, component(), snapshot(), container);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.imageBindings)).toBe(true);
    expect('set' in result.imageBindings).toBe(false);
    const url = container.querySelector('img')!.getAttribute('src')!;
    const html = `<p>${url}</p><a href="${url}">link</a><img src="${url}">`;
    const parsed = document.createElement('template');
    // eslint-disable-next-line no-unsanitized/property -- inert test assertions
    parsed.innerHTML = normalizeWeChatPublishingImages(html, result.imageBindings);
    expect(parsed.content.querySelector('p')?.textContent).toBe(url);
    expect(parsed.content.querySelector('a')?.getAttribute('href')).toBe(url);
    expect(parsed.content.querySelector('img')?.getAttribute('src')).toBe('ailu-asset://local');
  });


  test('rejects unknown browser blob schemes with embedded ASCII whitespace', () => {
    expect(() => normalizeWeChatPublishingImages('<img src="bl&#9;ob:app://foreign/图片.jpeg">', new Map()))
      .toThrow('正文图片未通过本地预检');
  });

});
