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

async function preparedCards(settingCover: string, metadata: Record<string, unknown>, templateId = 'jacky-cover') {
  const manager = new RedNoteSettingsManager({
    load: async () => ({ rednote: { templateId, coverImage: settingCover } }),
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
  return { prepared, settings: manager.getSettings() };
}

test('RedNote starts with body content even when legacy cover settings and metadata exist', async () => {
  const metadata = { cover_image: 'frontmatter.png', cover: 'other.png', image: 'third.png' };
  const result = await preparedCards('data:image/png;base64,setting', metadata);
  expect(result.prepared.data?.cards.map(card => card.kind)).toEqual(['content']);
  expect(result.prepared.data?.cards[0].fileName).toBe('文章-01-文章.png');
  expect(result.prepared.data?.cards[0].bodyHtml).toContain('正文');
  expect(result.prepared.data?.cards[0].bodyHtml).toContain('body-first.png');
  expect(result.prepared.previewHtml).not.toContain('ailu-rednote-jacky-cover-section');
  expect(result.settings.coverImage).toBe('data:image/png;base64,setting');
  expect(metadata).toEqual({ cover_image: 'frontmatter.png', cover: 'other.png', image: 'third.png' });
});


test('all thirteen templates preserve the body image and number content from 01', async () => {
  const manager = new RedNoteSettingsManager({ load: async () => null, save: async () => {} });
  const templates = manager.getTemplates();
  expect(templates).toHaveLength(13);
  for (const template of templates) {
    const { prepared } = await preparedCards('', { cover_image: 'body-first.png' }, template.id);
    expect(prepared.data?.cards.map(card => card.kind), template.id).toEqual(['content']);
    expect(prepared.data?.cards[0].fileName, template.id).toBe('文章-01-文章.png');
    const preview = new dom.window.DOMParser().parseFromString(prepared.previewHtml, 'text/html');
    expect(preview.querySelectorAll('img[src="body-first.png"]'), template.id).toHaveLength(1);
    expect(preview.querySelector('.ailu-rednote-jacky-cover-section'), template.id).toBeNull();
  }
});
