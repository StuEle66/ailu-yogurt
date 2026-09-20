import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { Notice, setIcon, type App, type TFile } from 'obsidian';

import {
  addImagePostMaterial,
  moveImagePostMaterial,
  prepareImagePost,
  removeImagePostMaterial,
  resetDestinationImagePostCopy,
  setDestinationImagePostCopy,
  setImagePostLeadMaterial,
  updateSharedImagePostCopy,
  type ImagePostCopy,
  type ImagePostDestination,
  type ImagePostDraft,
  type ImagePostMaterial,
} from '../imagePost';
import type { ImagePostWorkspaceController } from '../imagePost/controller';
import type { AiluSettings } from '../types';
import {
  attentionPublishingTargetActivity,
  IDLE_PUBLISHING_TARGET_ACTIVITY,
  runningPublishingTargetActivity,
} from './publishingTargetActivity';
import { readRedNoteSource, RedNotePublishingPanel } from './redNotePublishingPanel';

interface ImagePostPublishingPanelDeps {
  app: App;
  file: TFile | null;
  workspace: ImagePostWorkspaceController;
  getSettings: () => AiluSettings;
  saveSettings: () => Promise<void>;
  requestRender: () => void;
  openSettings: () => void;
}

interface ElectronWebUtils {
  getPathForFile(file: File): string;
}

const electronWebUtils = (window as unknown as {
  require?: (moduleId: 'electron') => { webUtils?: ElectronWebUtils };
}).require?.('electron').webUtils;

export class ImagePostPublishingPanel {
  private readonly cards: RedNotePublishingPanel | null;
  private draft: ImagePostDraft | null = null;
  private loading = false;
  private busy = false;
  private error = '';
  private status = '';
  private includeRedNote = true;
  private includeWechat = true;
  private disposed = false;
  private handoffAbort: AbortController | null = null;

  constructor(private readonly deps: ImagePostPublishingPanelDeps) {
    this.cards = deps.file ? new RedNotePublishingPanel({
      app: deps.app,
      file: deps.file,
      getSettings: deps.getSettings,
      saveSettings: deps.saveSettings,
      requestRender: deps.requestRender,
      openSettings: deps.openSettings,
    }) : null;
  }

  isBusy(): boolean { return this.busy || Boolean(this.cards?.isBusy()); }
  activity() {
    if (this.isBusy()) return runningPublishingTargetActivity(this.status || '正在准备图文');
    if (this.error) return attentionPublishingTargetActivity('图文需要检查');
    return IDLE_PUBLISHING_TARGET_ACTIVITY;
  }
  activate(): void {
    this.cards?.activate();
    if (!this.draft && !this.loading) void this.load();
  }
  refresh(): Promise<void> { return this.cards?.refresh() ?? Promise.resolve(); }
  dispose(): void { this.disposed = true; this.cards?.dispose(); }

  async render(parent: HTMLElement): Promise<void> {
    if (!this.draft && !this.loading) void this.load();
    const root = parent.createDiv({ cls: 'ailu-image-post-panel' });
    if (this.cards) await this.cards.render(root);
    const composer = root.createDiv({ cls: 'ailu-image-post-composer' });
    const header = composer.createDiv({ cls: 'ailu-image-post-composer-header' });
    const heading = header.createDiv();
    heading.createEl('h3', { text: '图文草稿' });
    heading.createEl('p', { text: this.deps.file ? '图卡和照片可以混排；发送后会停在后台编辑页。' : '纯照片模式；无需打开 Markdown。' });
    const importButton = header.createEl('button', { attr: { type: 'button' } });
    setIcon(importButton.createSpan(), 'images');
    importButton.createSpan({ text: '选择照片' });
    importButton.disabled = this.busy;
    importButton.onclick = () => void this.choosePhotos();

    if (this.loading) {
      composer.createDiv({ cls: 'ailu-rednote-inline-status', text: '正在恢复图文草稿…' });
      return;
    }
    if (this.error) composer.createDiv({ cls: 'ailu-rednote-inline-status is-error', text: this.error });
    if (this.status) composer.createDiv({ cls: 'ailu-rednote-inline-status', text: this.status });
    const draft = this.draft;
    if (!draft) return;

    const drop = composer.createDiv({
      cls: 'ailu-image-post-dropzone',
      attr: { tabindex: '0', role: 'button', 'aria-label': '拖入或选择图文照片' },
    });
    drop.createSpan({ text: draft.materials.length ? `${draft.materials.length} 张素材` : '拖入 JPEG、PNG 或 WebP 照片' });
    drop.ondragover = event => { event.preventDefault(); drop.addClass('is-dragging'); };
    drop.ondragleave = () => drop.removeClass('is-dragging');
    drop.ondrop = event => {
      event.preventDefault(); drop.removeClass('is-dragging');
      void this.importFiles(event.dataTransfer?.files ?? null);
    };
    drop.onclick = () => void this.choosePhotos();

    if (this.cards) {
      const addCards = composer.createEl('button', { cls: 'ailu-image-post-add-cards', text: '加入当前 Markdown 图卡', attr: { type: 'button' } });
      addCards.disabled = this.isBusy();
      addCards.onclick = () => void this.materializeCards();
    }
    this.renderMaterials(composer, draft);
    this.renderCopyEditor(composer, draft);
    this.renderDestinations(composer, draft);
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.deps.requestRender();
    try {
      const source = this.deps.file ? await readRedNoteSource(this.deps.app, this.deps.file) : '';
      const identity = this.deps.file ? {
        articlePath: this.deps.file.path,
        contentVersion: createHash('sha256').update(source, 'utf8').digest('hex'),
      } : null;
      const draft = await this.deps.workspace.loadDraft(identity);
      if (identity) draft.source = identity;
      if (!draft.sharedCopy.title && this.deps.file) draft.sharedCopy.title = this.deps.file.basename;
      this.draft = draft;
      await this.deps.workspace.saveDraft(draft);
    } catch (error) { this.error = error instanceof Error ? error.message : '图文草稿恢复失败。'; }
    finally { this.loading = false; if (!this.disposed) this.deps.requestRender(); }
  }

  private renderMaterials(parent: HTMLElement, draft: ImagePostDraft): void {
    const list = parent.createDiv({ cls: 'ailu-image-post-materials' });
    draft.materials.forEach((material, index) => {
      const item = list.createDiv({ cls: material.id === draft.leadMaterialId ? 'ailu-image-post-material is-lead' : 'ailu-image-post-material' });
      item.createEl('img', { attr: { src: pathToFileURL(material.managedPath).href, alt: material.fileName } });
      const meta = item.createDiv({ cls: 'ailu-image-post-material-meta' });
      meta.createEl('strong', { text: material.kind === 'card' ? `图卡 ${material.renderedPage}` : material.originalName });
      meta.createSpan({ text: `${index + 1} · ${material.width}×${material.height}` });
      const actions = item.createDiv({ cls: 'ailu-image-post-material-actions' });
      this.materialButton(actions, 'arrow-left', '前移', () => this.moveMaterial(material.id, index - 1), index === 0);
      this.materialButton(actions, 'arrow-right', '后移', () => this.moveMaterial(material.id, index + 1), index === draft.materials.length - 1);
      this.materialButton(actions, 'star', '设为首图', () => this.setLead(material.id), material.id === draft.leadMaterialId);
      this.materialButton(actions, 'x', '移除', () => this.removeMaterial(material.id));
    });
  }

  private renderCopyEditor(parent: HTMLElement, draft: ImagePostDraft): void {
    const section = parent.createDiv({ cls: 'ailu-image-post-copy' });
    section.createEl('h4', { text: '共用文案' });
    this.renderCopyFields(section, draft.sharedCopy, copy => {
      this.draft = updateSharedImagePostCopy(draft, copy); void this.persistAndRender();
    });
    const overrides = section.createDiv({ cls: 'ailu-image-post-overrides' });
    for (const destination of ['rednote', 'wechat-image'] as const) {
      const label = destination === 'rednote' ? '小红书单独调整' : '微信贴图单独调整';
      const enabled = Boolean(draft.destinationCopy[destination]);
      const row = overrides.createEl('label');
      const toggle = row.createEl('input', { type: 'checkbox' });
      toggle.checked = enabled;
      row.createSpan({ text: label });
      toggle.onchange = () => {
        this.draft = toggle.checked
          ? setDestinationImagePostCopy(draft, destination, draft.sharedCopy)
          : resetDestinationImagePostCopy(draft, destination);
        void this.persistAndRender();
      };
      if (enabled) this.renderCopyFields(overrides, draft.destinationCopy[destination]!, copy => {
        this.draft = setDestinationImagePostCopy(draft, destination, copy); void this.persistAndRender();
      }, destination === 'rednote' ? '小红书' : '微信贴图');
    }
  }

  private renderCopyFields(parent: HTMLElement, copy: ImagePostCopy, onChange: (copy: ImagePostCopy) => void, prefix = ''): void {
    const fields = parent.createDiv({ cls: 'ailu-image-post-copy-fields' });
    const title = fields.createEl('input', { type: 'text', value: copy.title, attr: { placeholder: `${prefix}标题`, 'aria-label': `${prefix || '共用'}标题` } });
    const body = fields.createEl('textarea', { attr: { placeholder: `${prefix}文案`, 'aria-label': `${prefix || '共用'}文案` } });
    body.value = copy.body;
    const topics = fields.createEl('input', { type: 'text', value: copy.topics.join(' '), attr: { placeholder: '话题，以空格分隔', 'aria-label': `${prefix || '共用'}话题` } });
    const update = (): void => onChange({
      title: title.value,
      body: body.value,
      topics: topics.value.split(/\s+/u).map(value => value.replace(/^#+/u, '')).filter(Boolean),
    });
    title.onchange = update; body.onchange = update; topics.onchange = update;
  }

  private renderDestinations(parent: HTMLElement, draft: ImagePostDraft): void {
    const footer = parent.createDiv({ cls: 'ailu-image-post-handoff' });
    const choices = footer.createDiv({ cls: 'ailu-image-post-destinations' });
    this.destinationToggle(choices, '小红书', this.includeRedNote, value => { this.includeRedNote = value; });
    this.destinationToggle(choices, '微信贴图', this.includeWechat, value => { this.includeWechat = value; });
    const handoff = footer.createEl('button', { cls: 'mod-cta', text: '填入所选后台', attr: { type: 'button' } });
    handoff.disabled = this.busy || !draft.materials.length || (!this.includeRedNote && !this.includeWechat);
    handoff.onclick = () => void this.handoff();
    if (this.handoffAbort) {
      const stop = footer.createEl('button', { text: '停止填写', attr: { type: 'button' } });
      stop.onclick = () => this.handoffAbort?.abort();
    }
  }

  private destinationToggle(parent: HTMLElement, label: string, checked: boolean, change: (value: boolean) => void): void {
    const row = parent.createEl('label');
    const input = row.createEl('input', { type: 'checkbox' }); input.checked = checked;
    row.createSpan({ text: label }); input.onchange = () => change(input.checked);
  }

  private async choosePhotos(): Promise<void> {
    const input = document.body.createEl('input', { type: 'file' });
    input.accept = 'image/jpeg,image/png,image/webp,.heic,.heif'; input.multiple = true; input.hidden = true;
    input.onchange = () => { const files = input.files; input.remove(); void this.importFiles(files); };
    input.click();
  }

  private async importFiles(files: FileList | null): Promise<void> {
    if (!files?.length || !this.draft || this.busy) return;
    this.busy = true; this.status = '正在复制照片到 .ailu 受管目录…'; this.error = ''; this.deps.requestRender();
    try {
      let next = this.draft;
      for (const file of Array.from(files)) {
        const sourcePath = electronWebUtils?.getPathForFile(file) || (file as File & { path?: string }).path;
        if (!sourcePath) throw new Error(`无法读取“${file.name}”的本地路径。`);
        const dimensions = await imageDimensions(file);
        const material = await this.deps.workspace.importPhoto({ sourcePath, originalName: file.name, ...dimensions });
        next = addImagePostMaterial(next, material);
      }
      this.draft = next; await this.deps.workspace.saveDraft(next); this.status = `已加入 ${files.length} 张照片。`;
    } catch (error) { this.error = error instanceof Error ? error.message : '照片导入失败。'; }
    finally { this.busy = false; if (!this.disposed) this.deps.requestRender(); }
  }

  private async materializeCards(): Promise<void> {
    if (!this.cards || !this.draft || this.busy) return;
    this.busy = true; this.status = '正在冻结当前图卡…'; this.error = ''; this.deps.requestRender();
    try {
      const rendered = await this.cards.renderImagesForPost();
      const cards: ImagePostMaterial[] = [];
      for (let index = 0; index < rendered.length; index += 1) {
        cards.push(await this.deps.workspace.importRenderedCard({
          bytes: new Uint8Array(await rendered[index].blob.arrayBuffer()),
          fileName: rendered[index].fileName,
          page: index + 1,
          width: 1800,
          height: 2400,
        }));
      }
      let next: ImagePostDraft = {
        ...this.draft,
        materials: this.draft.materials.filter(material => material.kind !== 'card'),
      };
      for (const card of cards) next = addImagePostMaterial(next, card);
      this.draft = next; await this.deps.workspace.saveDraft(next); this.status = `已加入 ${cards.length} 张当前图卡。`;
    } catch (error) { this.error = error instanceof Error ? error.message : '图卡冻结失败。'; }
    finally { this.busy = false; if (!this.disposed) this.deps.requestRender(); }
  }

  private async handoff(): Promise<void> {
    if (!this.draft || this.busy) return;
    const destinations: ImagePostDestination[] = [];
    if (this.includeRedNote) destinations.push('rednote');
    if (this.includeWechat) destinations.push('wechat-image');
    this.busy = true; this.status = '正在打开专用 Chrome 并填入内容…'; this.error = ''; this.deps.requestRender();
    this.handoffAbort = new AbortController();
    try {
      const prepared = prepareImagePost(this.draft, destinations);
      const results = await this.deps.workspace.handoff(prepared, this.handoffAbort.signal);
      const outcomes = Object.values(results).flatMap(result => Object.values(result.outcomes));
      this.status = outcomes.map(outcome => outcome?.message).filter(Boolean).join('；') || '后台填写已完成，请在 Chrome 中检查。';
      new Notice(this.status, 10_000);
    } catch (error) { this.error = error instanceof Error ? error.message : '图文后台填写失败。'; new Notice(this.error, 10_000); }
    finally { this.handoffAbort = null; this.busy = false; if (!this.disposed) this.deps.requestRender(); }
  }

  private materialButton(parent: HTMLElement, icon: string, label: string, action: () => void, disabled = false): void {
    const button = parent.createEl('button', { attr: { type: 'button', title: label, 'aria-label': label } });
    setIcon(button, icon); button.disabled = disabled || this.busy; button.onclick = event => { event.stopPropagation(); action(); };
  }
  private moveMaterial(id: string, index: number): void { if (this.draft) { this.draft = moveImagePostMaterial(this.draft, id, index); void this.persistAndRender(); } }
  private setLead(id: string): void { if (this.draft) { this.draft = setImagePostLeadMaterial(this.draft, id); void this.persistAndRender(); } }
  private removeMaterial(id: string): void { if (this.draft) { this.draft = removeImagePostMaterial(this.draft, id); void this.persistAndRender(); } }
  private async persistAndRender(): Promise<void> { if (this.draft) await this.deps.workspace.saveDraft(this.draft); if (!this.disposed) this.deps.requestRender(); }
}

async function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效。');
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch { throw new Error(`图片“${file.name}”无法解码；HEIC 请先从照片应用导出为 JPEG。`); }
  finally { URL.revokeObjectURL(url); }
}
