import { JSDOM } from 'jsdom';
import type { App, TFile } from 'obsidian';
import { RedNoteExporter, RedNoteSettingsManager, ImageResolver, DEFAULT_REDNOTE_SETTINGS, getRedNoteTemplatePreset } from '../src/rednote';
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
