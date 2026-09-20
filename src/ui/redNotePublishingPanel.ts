import type { AiluSettings } from '../types';

/** Import only the legacy layout block. Reads never write to the legacy plugin. */
export async function initializeRedNoteImport(
  settings: AiluSettings,
  readLegacy: () => Promise<string>,
  save: () => Promise<void>,
  retry = false,
): Promise<void> {
  if (settings.redNoteImport.status === 'imported' || settings.redNoteImport.status === 'skipped') return;
  if (settings.redNoteImport.status === 'failed' && !retry) return;
  const previous = settings.rednote;
  let imported: typeof settings.rednote | null = null;
  try {
    if (Object.keys(previous).length) {
      settings.redNoteImport = { status: 'skipped', error: '' };
      await save();
      return;
    }
    const parsed: unknown = JSON.parse(await readLegacy());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MDFlow 设置不是有效对象。');
    const legacy = (parsed as Record<string, unknown>).rednote;
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('MDFlow 中没有可导入的小红书设置。');
    const allowed = [
      'templateId', 'fontFamily', 'fontSize', 'userAvatar', 'userName', 'userId', 'showTime', 'timeFormat',
      'notesTitle', 'brandTagline', 'footerLeftText', 'footerRightText', 'coverImage', 'aboutTitle', 'aboutBio',
      'aboutCallout', 'supportTitle', 'supportText', 'supportQrImage', 'supportBannerImage', 'officialTitle',
      'officialText', 'officialQrImage', 'officialBannerImage', 'customFonts',
    ];
    const entries = Object.entries(legacy).filter(([key]) => allowed.includes(key));
    for (const [key, value] of entries) {
      const valid = key === 'fontSize' ? typeof value === 'number' && Number.isFinite(value)
        : key === 'showTime' ? typeof value === 'boolean'
        : key === 'customFonts' ? Array.isArray(value) && value.every((font: unknown) => font && typeof font === 'object'
          && typeof (font as Record<string, unknown>).label === 'string' && typeof (font as Record<string, unknown>).value === 'string')
        : typeof value === 'string';
      if (!valid) throw new Error(`MDFlow 小红书设置字段损坏：${key}`);
    }
    if (settings.rednote !== previous || Object.keys(settings.rednote).length) {
      settings.redNoteImport = { status: 'skipped', error: '' };
      await save(); return;
    }
    imported = Object.fromEntries(entries.map(([key, value]) => [key, key === 'customFonts'
      ? (value as Array<Record<string, unknown>>).map(font => ({ label: font.label, value: font.value, isPreset: font.isPreset === true })) : value]));
    settings.rednote = imported;
    settings.redNoteImport = { status: 'imported', error: '' };
    await save();
  } catch (error) {
    if (settings.rednote === imported) settings.rednote = previous;
    settings.redNoteImport = { status: 'failed', error: error instanceof Error ? error.message : '导入失败。' };
    try { await save(); } catch { /* Visible failed state remains available for retry. */ }
  }
}

import { MarkdownView, Menu, Notice, sanitizeHTMLToDom, setIcon, type App, type TFile } from 'obsidian';
import {
  RedNoteExporter, RedNoteSettingsManager, MarkdownConverter, ImageResolver,
  loadBundledFonts, RedNoteAboutModal, REDNOTE_HANDWRITING_FONT, type RedNoteSettings,
} from '../rednote';
import type { RenderedRedNoteImage } from '../rednote/exporters/rednote-exporter';
import { IDLE_PUBLISHING_TARGET_ACTIVITY, runningPublishingTargetActivity, attentionPublishingTargetActivity } from './publishingTargetActivity';

/** Read the editor for this exact note, even when another leaf is active. */
export async function readRedNoteSource(app: App, file: TFile): Promise<string> {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) return leaf.view.editor.getValue();
  }
  return app.vault.read(file);
}


/** System picker shared by the workspace and all six settings assets. */
export function chooseRedNoteImage(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.body.createEl('input', { type: 'file' });
    input.accept = 'image/jpeg,image/png,image/webp'; input.hidden = true;
    input.addEventListener('cancel', () => { input.remove(); resolve(null); }, { once: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0]; input.remove();
      if (!file) { resolve(null); return; }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size === 0 || file.size > 10 * 1024 * 1024) {
        reject(new Error('请选择小于 10 MB 的有效 JPEG、PNG 或 WebP 图片。')); return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
      reader.onload = () => { void (async () => {
        try {
          if (typeof reader.result !== 'string') throw new Error('图片读取失败。');
          const image = new Image(); image.src = reader.result; await image.decode();
          if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效。');
          resolve(reader.result);
        } catch { reject(new Error('图片无法解码，请重新选择 JPEG、PNG 或 WebP 图片。')); }
      })(); };
      reader.readAsDataURL(file);
    }, { once: true });
    input.click();
  });
}

export function redNoteTemplateSettingsPatch(templateId: string): Partial<RedNoteSettings> {
  return templateId === 'handdrawn-notes'
    ? { templateId, fontFamily: REDNOTE_HANDWRITING_FONT }
    : { templateId };
}

interface RedNotePanelDeps {
  app: App;
  file: TFile;
  getSettings: () => AiluSettings;
  saveSettings: () => Promise<void>;
  requestRender: () => void;
  openSettings: () => void;
}

type RedNoteContent = Awaited<ReturnType<RedNoteExporter['prepare']>>;

const REDNOTE_PREVIEW_WIDTH = 450;
const REDNOTE_PREVIEW_HEIGHT = 600;

export function redNotePreviewLayout(availableWidth: number, availableHeight = REDNOTE_PREVIEW_HEIGHT): {
  scale: number;
  width: number;
  height: number;
} {
  const safeWidth = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0;
  const safeHeight = Number.isFinite(availableHeight) ? Math.max(0, availableHeight) : 0;
  const scale = Math.min(1, safeWidth / REDNOTE_PREVIEW_WIDTH, safeHeight / REDNOTE_PREVIEW_HEIGHT);
  return {
    scale,
    width: REDNOTE_PREVIEW_WIDTH * scale,
    height: REDNOTE_PREVIEW_HEIGHT * scale,
  };
}

export function redNoteStatusBarInset(
  panel: Pick<DOMRect, 'left' | 'right' | 'bottom'>,
  status: Pick<DOMRect, 'left' | 'right' | 'top'> | null,
): number {
  if (!status || panel.right <= status.left || panel.left >= status.right) return 0;
  return Math.max(0, Math.min(80, panel.bottom - status.top));
}

export class RedNotePublishingPanel {
  private manager: RedNoteSettingsManager;
  private converter: MarkdownConverter;
  private exporter: RedNoteExporter;
  private content: RedNoteContent | null = null;
  private source = '';
  private currentPage = 0;
  private busy = false;
  private refreshRequested = false;
  private retryImportRequested = false;
  private disposed = false;
  private started = false;
  private error = '';
  private fontCleanup: (() => void) | null = null;
  private readonly sourcePath: string;
  private preview: HTMLElement | null = null;
  private previewResizeObserver: ResizeObserver | null = null;
  private pageIndicatorObserver: MutationObserver | null = null;
  private safeAreaResizeObserver: ResizeObserver | null = null;

  constructor(private readonly deps: RedNotePanelDeps) {
    this.sourcePath = deps.file.path;
    this.manager = new RedNoteSettingsManager({
      load: async () => ({ rednote: deps.getSettings().rednote }),
      save: async data => {
        const settings = deps.getSettings();
        const previous = settings.rednote;
        settings.rednote = data.rednote ?? {};
        try { await deps.saveSettings(); } catch (error) { settings.rednote = previous; throw error; }
      },
      reportError: message => { this.error = message; },
    });
    this.converter = new MarkdownConverter(deps.app);
    this.exporter = new RedNoteExporter(new ImageResolver(deps.app), this.manager);
  }

  isBusy(): boolean { return this.busy; }
  pageCount(): number { return this.content?.data?.cards.length ?? 0; }
  activity() {
    return this.busy ? runningPublishingTargetActivity('正在生成图卡')
      : this.error ? attentionPublishingTargetActivity('图卡需要检查') : IDLE_PUBLISHING_TARGET_ACTIVITY;
  }
  activate(): void { if (!this.started && !this.busy && !this.disposed) void this.refresh(); }
  dispose(): void {
    this.disposed = true;
    this.refreshRequested = false;
    this.retryImportRequested = false;
    this.converter.dispose();
    this.disconnectRenderObservers();
    this.fontCleanup?.();
    this.fontCleanup = null;
  }

  private assertSource(): void {
    if (this.disposed || this.deps.file.path !== this.sourcePath
      || this.deps.app.vault.getAbstractFileByPath(this.sourcePath) !== this.deps.file) {
      throw new Error('原文章已关闭、移动或删除，请重新打开图卡。');
    }
  }

  async refresh(retryImport = false): Promise<void> {
    if (this.disposed) return;
    if (this.busy) {
      this.refreshRequested = true;
      this.retryImportRequested ||= retryImport;
      return;
    }
    this.busy = true; this.started = true; this.error = '';
    this.deps.requestRender();
    try {
      await initializeRedNoteImport(this.deps.getSettings(),
        () => this.deps.app.vault.adapter.read(`${this.deps.app.vault.configDir}/plugins/yogurt-mdflow/data.json`),
        this.deps.saveSettings, retryImport);
      await this.manager.load();
      if (!this.fontCleanup) {
        const cleanup = await loadBundledFonts(this.deps.app, `${this.deps.app.vault.configDir}/plugins/ailu`);
        if (this.disposed) { cleanup(); return; }
        this.fontCleanup = cleanup;
      }
      this.assertSource();
      const source = await readRedNoteSource(this.deps.app, this.deps.file);
      const html = await this.converter.convertToHtml(source, this.deps.file);
      const content = await this.exporter.prepare(html, this.context());
      this.assertSource();
      this.source = source; this.content = content;
    } catch (error) { this.error = error instanceof Error ? error.message : '图卡生成失败。'; }
    finally {
      this.busy = false;
      const queued = this.refreshRequested;
      const retry = this.retryImportRequested;
      this.refreshRequested = false;
      this.retryImportRequested = false;
      if (!this.disposed && queued) void this.refresh(retry);
      else if (!this.disposed) this.deps.requestRender();
    }
  }

  private context() { return { app: this.deps.app, sourceFile: this.deps.file, title: this.deps.file.basename }; }

  async updateSettings(patch: Partial<RedNoteSettings>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.deps.requestRender();
    try {
      await this.manager.update(patch);
      this.busy = false;
      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : '设置保存失败。';
    } finally { this.busy = false; if (!this.disposed) this.deps.requestRender(); }
  }

  async renderImagesForPost(): Promise<RenderedRedNoteImage[]> {
    if (this.busy || !this.content) throw new Error('图卡仍在生成，请稍后重试。');
    this.assertSource();
    if (await readRedNoteSource(this.deps.app, this.deps.file) !== this.source) {
      throw new Error('文章已变化，请先刷新图卡后再发送。');
    }
    return this.exporter.renderImages(this.content, this.context());
  }

  async render(parent: HTMLElement): Promise<void> {
    this.disconnectRenderObservers();
    const panel = parent.createDiv({ cls: 'ailu-rednote-panel ailu-rednote-scope' });
    const toolbar = panel.createDiv({ cls: 'ailu-rednote-workbench-toolbar' });
    const heading = toolbar.createDiv({ cls: 'ailu-rednote-workbench-heading' });
    heading.createDiv({ cls: 'ailu-rednote-workbench-title', text: '小红书图卡' });
    const pageStatus = heading.createDiv({
      cls: 'ailu-rednote-workbench-status',
      text: this.busy ? '正在生成…' : this.content ? `${this.currentPage + 1} / ${this.content.data?.cards.length ?? 0}` : '等待生成',
    });
    const controls = toolbar.createDiv({ cls: 'ailu-rednote-controls' });
    const templateField = controls.createDiv({ cls: 'ailu-rednote-control-field is-template' });
    templateField.createEl('label', { text: '模板' });
    const template = templateField.createEl('select', { attr: { 'aria-label': '小红书模板' } });
    for (const preset of this.manager.getTemplates()) template.createEl('option', { value: preset.id, text: preset.name });
    template.value = this.manager.getSettings().templateId;
    template.disabled = this.busy;
    template.onchange = () => void this.updateSettings(redNoteTemplateSettingsPatch(template.value));
    const fontField = controls.createDiv({ cls: 'ailu-rednote-control-field is-font' });
    fontField.createEl('label', { text: '字体' });
    const font = fontField.createEl('select', { attr: { 'aria-label': '小红书字体' } });
    for (const option of this.manager.getFontOptions()) font.createEl('option', { value: option.value, text: option.label });
    font.value = this.manager.getSettings().fontFamily; font.disabled = this.busy;
    font.onchange = () => void this.updateSettings({ fontFamily: font.value });
    const sizeField = controls.createDiv({ cls: 'ailu-rednote-control-field is-size' });
    sizeField.createEl('label', { text: '字号' });
    const size = sizeField.createEl('input', { type: 'number', attr: { 'aria-label': '小红书字号', min: '12', max: '28' } });
    size.value = String(this.manager.getSettings().fontSize); size.disabled = this.busy;
    size.onchange = () => void this.updateSettings({ fontSize: Number(size.value) });
    const actions = toolbar.createDiv({ cls: 'ailu-rednote-toolbar-actions' });
    const refresh = this.createToolbarButton(actions, 'refresh-cw', '刷新');
    refresh.disabled = this.busy; refresh.onclick = () => void this.refresh();
    for (const [field, label, icon] of [['userAvatar', '头像', 'circle-user-round']] as const) {
      const button = this.createToolbarButton(actions, icon, label); button.disabled = this.busy;
      button.onclick = () => { void (async () => {
        try { const image = await chooseRedNoteImage(); if (image) await this.updateSettings({ [field]: image }); }
        catch (error) { new Notice(error instanceof Error ? error.message : '图片选择失败。'); }
      })(); };
    }
    const settings = this.createToolbarButton(actions, 'settings-2', '设置');
    settings.onclick = this.deps.openSettings;
    const more = this.createToolbarButton(actions, 'ellipsis', '更多', true);
    more.onclick = event => this.openMoreMenu(event, more);
    const importState = this.deps.getSettings().redNoteImport;
    if (importState.status === 'failed') {
      const warning = panel.createDiv({ cls: 'ailu-rednote-inline-status is-warning' });
      warning.createSpan({ text: `旧设置导入失败：${importState.error}` });
      const retry = panel.createEl('button', { text: '重试导入旧设置' });
      warning.appendChild(retry);
      retry.disabled = this.busy; retry.onclick = () => void this.refresh(true);
    }
    if (this.error) panel.createDiv({ cls: 'ailu-rednote-inline-status is-error', text: this.error });
    this.preview = panel.createDiv({ cls: 'ailu-rednote-preview', attr: { 'data-platform': 'rednote' } });
    if (this.content) {
      this.preview.appendChild(sanitizeHTMLToDom(this.content.previewHtml));
      this.exporter.mountPreview(this.preview, this.content, this.context(), {
        initialPage: this.currentPage,
        onPageChange: page => { this.currentPage = page; },
      });
      this.bindResponsivePreview(pageStatus);
    }
    const footer = panel.createDiv({ cls: 'ailu-rednote-panel-footer' });
    const single = this.createToolbarButton(footer, 'image-down', '当前页 PNG');
    const all = this.createToolbarButton(footer, 'archive', '全部页 ZIP');
    all.addClass('mod-cta');
    single.disabled = all.disabled = this.busy || !this.content;
    single.onclick = () => void this.exportImages(false);
    all.onclick = () => void this.exportImages(true);
    this.bindFooterSafeArea(panel, parent);
  }

  private createToolbarButton(parent: HTMLElement, iconName: string, label: string, iconOnly = false): HTMLButtonElement {
    const button = parent.createEl('button', {
      cls: iconOnly ? 'ailu-rednote-icon-button is-icon-only' : 'ailu-rednote-icon-button',
      attr: { type: 'button', 'aria-label': label, title: label },
    });
    const icon = button.createSpan({ cls: 'ailu-rednote-button-icon' });
    setIcon(icon, iconName);
    if (!iconOnly) button.createSpan({ cls: 'ailu-rednote-button-label', text: label });
    return button;
  }

  private openMoreMenu(event: MouseEvent, trigger: HTMLElement): void {
    const menu = new Menu();
    menu.addItem(item => item.setTitle('使用指南').setIcon('circle-help').onClick(() => {
      new Notice('正文可用 --- 手动分页。用左右箭头切换页面，再导出当前页 PNG 或全部页 ZIP；原笔记不会被改写。', 10_000);
    }));
    menu.addItem(item => item.setTitle('关于酸奶糖').setIcon('badge-info').onClick(() => {
      new RedNoteAboutModal(this.deps.app, this.manager.getSettings()).open();
    }));
    if (typeof menu.showAtMouseEvent === 'function') menu.showAtMouseEvent(event);
    else menu.showAtPosition({ x: trigger.getBoundingClientRect().left, y: trigger.getBoundingClientRect().bottom });
  }

  private bindResponsivePreview(pageStatus: HTMLElement): void {
    if (!this.preview) return;
    const wrapper = this.preview.querySelector<HTMLElement>('.ailu-rednote-preview-wrapper');
    const container = wrapper?.querySelector<HTMLElement>('.ailu-rednote-preview-container');
    const indicator = wrapper?.querySelector<HTMLElement>('.ailu-rednote-page-indicator');
    if (!wrapper || !container) return;
    const viewport = document.createElement('div');
    viewport.className = 'ailu-rednote-preview-scale-viewport';
    container.before(viewport);
    viewport.appendChild(container);
    const updateScale = (): void => {
      const availableWidth = viewport.getBoundingClientRect().width || viewport.clientWidth;
      const availableHeight = viewport.getBoundingClientRect().height;
      if (!viewport.isConnected || availableWidth <= 0 || availableHeight <= 0) return;
      const layout = redNotePreviewLayout(availableWidth, availableHeight);
      container.style.setProperty('--ailu-rednote-preview-scale', String(layout.scale));
    };
    this.previewResizeObserver = new ResizeObserver(updateScale);
    this.previewResizeObserver.observe(viewport);
    updateScale();
    if (indicator) {
      const updatePageStatus = (): void => { pageStatus.setText(indicator.textContent?.trim() || '图卡'); };
      this.pageIndicatorObserver = new MutationObserver(updatePageStatus);
      this.pageIndicatorObserver.observe(indicator, { childList: true, characterData: true, subtree: true });
      updatePageStatus();
    }
  }

  private bindFooterSafeArea(panel: HTMLElement, viewport: HTMLElement): void {
    const statusBar = document.querySelector<HTMLElement>('.status-bar');
    const update = (): void => {
      const inset = redNoteStatusBarInset(viewport.getBoundingClientRect(), statusBar?.getBoundingClientRect() ?? null);
      panel.style.setProperty('--ailu-rednote-safe-bottom', `${inset}px`);
    };
    this.safeAreaResizeObserver = new ResizeObserver(update);
    this.safeAreaResizeObserver.observe(viewport);
    if (statusBar) this.safeAreaResizeObserver.observe(statusBar);
    update();
  }

  private disconnectRenderObservers(): void {
    this.previewResizeObserver?.disconnect();
    this.previewResizeObserver = null;
    this.pageIndicatorObserver?.disconnect();
    this.pageIndicatorObserver = null;
    this.safeAreaResizeObserver?.disconnect();
    this.safeAreaResizeObserver = null;
  }

  private async exportImages(all: boolean): Promise<void> {
    if (this.busy || !this.content || !this.preview) return;
    const content = this.content;
    const page = this.currentPage;
    this.busy = true; this.deps.requestRender();
    try {
      this.assertSource();
      if (await readRedNoteSource(this.deps.app, this.deps.file) !== this.source) throw new Error('文章已变化，请先刷新图卡后再导出。');
      const result = all ? await this.exporter.export(content, this.context())
        : await this.exporter.exportCurrentPage(content, this.context(), page);
      if (!result.success) throw new Error(result.message);
      new Notice(result.message);
    } catch (error) { this.error = error instanceof Error ? error.message : '图卡导出失败。'; new Notice(this.error); }
    finally { this.busy = false; if (!this.disposed) this.deps.requestRender(); }
  }
}
