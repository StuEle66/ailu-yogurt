import { JSDOM } from 'jsdom';
import type { App, TFile } from 'obsidian';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  Events: class { trigger() {} },
  Modal: class {},
  Notice: class {},
  TFile: class {},
}));

import { RedNoteExporter, RedNoteSettingsManager } from '../src/rednote';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM();
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

async function preparedCover(settingCover: string, metadata: Record<string, unknown>) {
  const manager = new RedNoteSettingsManager({
    load: async () => ({ rednote: { templateId: 'jacky-cover', coverImage: settingCover } }),
    save: async () => {},
  });
  await manager.load();
  const resolver = {
    resolveImagesToBase64: vi.fn(async (html: string) => html),
    resolveImageSrc: vi.fn(async (src: string) => `resolved:${src}`),
  };
  const app = { metadataCache: { getFileCache: () => ({ frontmatter: metadata }) } } as unknown as App;
  const exporter = new RedNoteExporter(resolver as never, manager);
  const sourceFile = { path: '文章.md', basename: '文章' } as TFile;
  const prepared = await exporter.prepare(
    '<h1>文章</h1><p>正文</p><img src="body-first.png">',
    { app, sourceFile, title: '文章' },
  );
  return { cover: prepared.data?.cards[0]?.coverImageSrc, resolver };
}

test('RedNote cover uses the saved image before article metadata and body images', async () => {
  const result = await preparedCover('data:image/png;base64,setting', { cover_image: 'frontmatter.png' });
  expect(result.cover).toBe('data:image/png;base64,setting');
  expect(result.resolver.resolveImageSrc).not.toHaveBeenCalled();
});

test('RedNote cover falls back from article metadata to the first body image', async () => {
  expect((await preparedCover('', { cover_image: 'frontmatter.png' })).cover).toBe('resolved:frontmatter.png');
  expect((await preparedCover('', {})).cover).toBe('body-first.png');
});
