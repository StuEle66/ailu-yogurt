import { JSDOM } from 'jsdom';
import type { App, TFile } from 'obsidian';
import { RedNoteExporter, RedNoteSettingsManager, ImageResolver, DEFAULT_REDNOTE_SETTINGS, getRedNoteTemplatePreset } from '../src/rednote';
const clipboardState = vi.hoisted(() => ({ blob: undefined as Blob | undefined }));
vi.mock('../src/rednote/exporters/clipboard', () => ({ writeImageToClipboard: async (blob: Blob) => { clipboardState.blob = blob; } }));
const zipState = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('obsidian', () => ({ Events: class { trigger() {} }, Modal: class {}, Notice: class {}, Component: class {}, TFile: class {} }));
vi.mock('html-to-image', () => ({ toBlob: async (element: HTMLElement) => new Blob([JSON.stringify({
  visible: element.querySelector('.ailu-rednote-section-active')?.textContent,
  headerHidden: element.classList.contains('ailu-rednote-account-header-hidden'),
  cover: element.classList.contains('ailu-rednote-jacky-cover-active'),
})], { type: 'image/png' }) }));
vi.mock('jszip', () => ({ default: class {
  file(name: string) { zipState.files.push(name); }
  async generateAsync() { return new Blob(['zip'], { type: 'application/zip' }); }
} }));
let dom: JSDOM;
let downloaded: Blob | undefined;
let fileName = '';
beforeEach(() => {
  dom = new JSDOM();
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { downloaded = blob; return 'blob:test'; }, revokeObjectURL: () => {} });
  dom.window.HTMLAnchorElement.prototype.click = function () { fileName = this.download; };
  downloaded = undefined; fileName = '';
  zipState.files = [];
});
afterEach(() => { vi.unstubAllGlobals(); dom.window.close(); });
function fixture() {
  const app = {} as App;
  const manager = new RedNoteSettingsManager({ load: async () => null, save: async () => {} });
  const exporter = new RedNoteExporter(new ImageResolver(app), manager);
  const context = { app, sourceFile: { basename: 'note' } as TFile, title: 'Test article' };
  const content: Awaited<ReturnType<RedNoteExporter['prepare']>> = {
    previewHtml: '<div class="ailu-rednote-scope"><div class="ailu-rednote-image-preview"><section class="ailu-rednote-content-section" data-show-header="true">Cover</section><section class="ailu-rednote-content-section" data-show-header="false">Body page</section></div></div>',
    data: { cards: [
      { title: 'cover', kind: 'cover', fileName: 'cover.png' },
      { title: 'body', kind: 'content', fileName: 'body-02.png' },
    ], settings: DEFAULT_REDNOTE_SETTINGS, template: getRedNoteTemplatePreset('jacky-cover') },
  };
  return { exporter, context, content };
}
test('export current page downloads the captured requested body card with its header state', async () => {
  const { exporter, context, content } = fixture();
  expect(await exporter.exportCurrentPage(content, context, 1)).toMatchObject({ success: true });
  expect(fileName).toBe('body-02.png');
  expect(JSON.parse(await downloaded!.text())).toEqual({ visible: 'Body page', headerHidden: true, cover: false });
  expect(document.body.children).toHaveLength(0);
});

test.each([-1, 2, 0.5, NaN])('an invalid page index %s cannot download a different page', async index => {
  const { exporter, context, content } = fixture();
  expect(await exporter.exportCurrentPage(content, context, index)).toMatchObject({ success: false });
  expect(downloaded).toBeUndefined();
  expect(document.body.children).toHaveLength(0);
});
test('cover export selects the cover frame without changing prepared HTML', async () => {
  const { exporter, context, content } = fixture();
  const original = content.previewHtml;
  expect(await exporter.exportCurrentPage(content, context, 0)).toMatchObject({ success: true });
  expect(JSON.parse(await downloaded!.text())).toEqual({ visible: 'Cover', headerHidden: false, cover: true });
  expect(content.previewHtml).toBe(original);
});

test('export all produces an ordered ZIP even when the article has one page', async () => {
  const { exporter, context, content } = fixture();
  content.data!.cards = [content.data!.cards[1]];
  content.previewHtml = '<div class="ailu-rednote-scope"><div class="ailu-rednote-image-preview"><section class="ailu-rednote-content-section" data-show-header="true">Only page</section></div></div>';
  expect(await exporter.export(content, context)).toMatchObject({ success: true });
  expect(fileName).toBe('Test-article-小红书图文.zip');
  expect(zipState.files).toEqual(['body-02.png']);
});

test('remounting a preview restores the selected page and reports subsequent navigation', () => {
  const { exporter, content } = fixture();
  const host = document.createElement('div');
  host.innerHTML = '<div class="ailu-rednote-preview-wrapper"><div class="ailu-rednote-image-preview"></div><button data-rednote-nav="prev"></button><span class="ailu-rednote-page-indicator"></span><button data-rednote-nav="next"></button></div>';
  for (let index = 0; index < 6; index++) {
    const section = document.createElement('section');
    section.className = 'ailu-rednote-content-section';
    section.textContent = `Page ${index + 1}`;
    host.querySelector('.ailu-rednote-image-preview')!.appendChild(section);
  }
  const pages: number[] = [];
  const mount = exporter.mountPreview.bind(exporter);
  mount(host, content, undefined, { initialPage: 4, onPageChange: page => pages.push(page) });
  expect(host.querySelector('.ailu-rednote-section-active')?.textContent).toBe('Page 5');
  (host.querySelector('[data-rednote-nav="next"]') as HTMLButtonElement).click();
  expect(pages).toEqual([4, 5]);
  const replacement = host.cloneNode(true) as HTMLElement;
  mount(replacement, content, undefined, { initialPage: pages.at(-1)!, onPageChange: page => pages.push(page) });
  expect(replacement.querySelector('.ailu-rednote-section-active')?.textContent).toBe('Page 6');
  replacement.querySelectorAll('.ailu-rednote-content-section').forEach((el, index) => { if (index >= 3) el.remove(); });
  const reduced = replacement.cloneNode(true) as HTMLElement;
  mount(reduced, content, undefined, { initialPage: 5, onPageChange: page => pages.push(page) });
  expect(reduced.querySelector('.ailu-rednote-section-active')?.textContent).toBe('Page 3');
  expect(pages.at(-1)).toBe(2);
});


test('copying the selected card uses frozen prepared HTML rather than the scaled live preview', async () => {
  const { exporter, content } = fixture();
  const host = document.createElement('div');
  host.innerHTML = '<div class="ailu-rednote-preview-wrapper"><button class="ailu-rednote-copy-button"></button><div class="ailu-rednote-image-preview"><section class="ailu-rednote-content-section">Live decoration</section><section class="ailu-rednote-content-section">Live decoration 2</section></div><button data-rednote-nav="prev"></button><span class="ailu-rednote-page-indicator"></span><button data-rednote-nav="next"></button></div>';
  clipboardState.blob = undefined;
  exporter.mountPreview(host, content, undefined, { initialPage: 1 });
  (host.querySelector('.ailu-rednote-copy-button') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(clipboardState.blob).toBeDefined());
  expect((JSON.parse(await clipboardState.blob!.text()) as { visible: string }).visible).toBe('Body page');
  expect(document.body.children).toHaveLength(0);
});
