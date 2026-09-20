import { createHash } from 'node:crypto';

import { Modal, Notice, setIcon, type App, type TFile } from 'obsidian';

import {
  addImagePostMaterial,
  ManagedImagePostPreviewStore,
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

interface MaterialPreviewState {
  contentHash: string;
  status: 'loading' | 'ready' | 'error';
  url: string | null;
  message: string;
}

interface DestinationRunState {
  status: 'idle' | 'running' | 'succeeded' | 'attention' | 'failed' | 'cancelled';
  message: string;
  abort: AbortController | null;
}

export class ImagePostPublishingPanel {
  private readonly cards: RedNotePublishingPanel | null;
  private readonly previewStore: ManagedImagePostPreviewStore;
  private readonly materialPreviews = new Map<string, MaterialPreviewState>();
  private draft: ImagePostDraft | null = null;
  private loading = false;
  private busy = false;
  private error = '';
  private status = '';
  private readonly destinationRuns: Record<ImagePostDestination, DestinationRunState> = {
    rednote: { status: 'idle', message: '', abort: null },
    'wechat-image': { status: 'idle', message: '', abort: null },
  };
  private disposed = false;

  constructor(private readonly deps: ImagePostPublishingPanelDeps) {
    this.previewStore = new ManagedImagePostPreviewStore({
      readMaterial: material => deps.workspace.readMaterialBytes(material),
    });
    this.cards = deps.file ? new RedNotePublishingPanel({
      app: deps.app,
      file: deps.file,
      getSettings: deps.getSettings,
      saveSettings: deps.saveSettings,
      requestRender: deps.requestRender,
      openSettings: deps.openSettings,
    }) : null;
  }

  isBusy(): boolean {
    return this.busy
      || Boolean(this.cards?.isBusy())
      || Object.values(this.destinationRuns).some(run => run.status === 'running');
  }
  activity() {
    const running = Object.values(this.destinationRuns).find(run => run.status === 'running');
    if (running) return runningPublishingTargetActivity(running.message || '正在准备图文');
    if (this.busy || this.cards?.isBusy()) return runningPublishingTargetActivity(this.status || '正在准备图文');
    if (this.error || Object.values(this.destinationRuns).some(run => run.status === 'failed' || run.status === 'attention')) {
      return attentionPublishingTargetActivity('图文需要检查');
    }
    return IDLE_PUBLISHING_TARGET_ACTIVITY;
  }
  activate(): void {
    this.cards?.activate();
    if (!this.draft && !this.loading) void this.load();
  }
  refresh(): Promise<void> { return this.cards?.refresh() ?? Promise.resolve(); }
  dispose(): void {
    this.disposed = true;
    this.previewStore.dispose();
    this.materialPreviews.clear();
    for (const run of Object.values(this.destinationRuns)) run.abort?.abort();
    this.cards?.dispose();
  }

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
    this.previewStore.retain(draft.materials);
    const activeIds = new Set(draft.materials.map(material => material.id));
    for (const id of this.materialPreviews.keys()) {
      if (!activeIds.has(id)) this.materialPreviews.delete(id);
    }
    const list = parent.createDiv({ cls: 'ailu-image-post-materials' });
    draft.materials.forEach((material, index) => {
      const item = list.createDiv({ cls: material.id === draft.leadMaterialId ? 'ailu-image-post-material is-lead' : 'ailu-image-post-material' });
      const preview = this.materialPreviews.get(material.id);
      if (!preview || preview.contentHash !== material.contentHash) {
        this.loadMaterialPreview(material);
        item.createDiv({ cls: 'ailu-image-post-material-placeholder', text: '正在读取图片…' });
      } else if (preview.status === 'ready' && preview.url) {
        const open = item.createEl('button', {
          cls: 'ailu-image-post-material-preview',
          attr: { type: 'button', 'aria-label': `查看大图：${material.fileName}` },
        });
        open.createEl('img', { attr: { src: preview.url, alt: material.fileName } });
        open.onclick = () => this.openMaterialPreview(draft, material.id);
      } else if (preview.status === 'error') {
        const failure = item.createDiv({ cls: 'ailu-image-post-material-error' });
        setIcon(failure.createSpan(), 'image-off');
        failure.createEl('strong', { text: '图片无法读取' });
        failure.createSpan({ text: preview.message });
        const recovery = failure.createDiv({ cls: 'ailu-image-post-material-recovery' });
        const remove = recovery.createEl('button', { text: '移除', attr: { type: 'button' } });
        remove.onclick = () => this.removeMaterial(material.id);
        const replace = recovery.createEl('button', { text: '重新选择', attr: { type: 'button' } });
        replace.onclick = () => void this.chooseReplacement(material.id);
      } else {
        item.createDiv({ cls: 'ailu-image-post-material-placeholder', text: '正在读取图片…' });
      }
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

  private loadMaterialPreview(material: ImagePostMaterial): void {
    const current = this.materialPreviews.get(material.id);
    if (current?.contentHash === material.contentHash) return;
    this.materialPreviews.set(material.id, {
      contentHash: material.contentHash,
      status: 'loading',
      url: null,
      message: '',
    });
    void this.previewStore.load(material).then(url => {
      const active = this.materialPreviews.get(material.id);
      if (!active || active.contentHash !== material.contentHash) return;
      this.materialPreviews.set(material.id, { ...active, status: 'ready', url });
      if (!this.disposed) this.deps.requestRender();
    }).catch(error => {
      const active = this.materialPreviews.get(material.id);
      if (!active || active.contentHash !== material.contentHash) return;
      this.materialPreviews.set(material.id, {
        ...active,
        status: 'error',
        message: error instanceof Error ? error.message : '图片文件无法读取。',
      });
      if (!this.disposed) this.deps.requestRender();
    });
  }

  private openMaterialPreview(draft: ImagePostDraft, materialId: string): void {
    const materials = draft.materials.flatMap(material => {
      const preview = this.materialPreviews.get(material.id);
      return preview?.status === 'ready' && preview.url
        ? [{ material, url: preview.url }]
        : [];
    });
    const index = materials.findIndex(entry => entry.material.id === materialId);
    if (index >= 0) new ImagePostMaterialPreviewModal(this.deps.app, materials, index).open();
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
    const actions = footer.createDiv({ cls: 'ailu-image-post-handoff-actions' });
    this.handoffButton(actions, draft, '填入小红书', ['rednote']);
    this.handoffButton(actions, draft, '填入微信贴图', ['wechat-image']);
    this.handoffButton(actions, draft, '双平台填入', ['rednote', 'wechat-image'], true);
    for (const destination of ['rednote', 'wechat-image'] as const) {
      const run = this.destinationRuns[destination];
      if (run.status === 'idle' || !run.message) continue;
      const row = footer.createDiv({
        cls: `ailu-image-post-destination-status is-${run.status}`,
      });
      row.createSpan({ text: `${destinationName(destination)}：${run.message}` });
      if (run.status === 'running') {
        const stop = row.createEl('button', {
          text: '停止',
          attr: { type: 'button', 'aria-label': `停止${destinationName(destination)}填写` },
        });
        stop.onclick = () => run.abort?.abort();
      } else if (run.status === 'failed') {
        const retry = row.createEl('button', {
          text: '重试',
          attr: { type: 'button', 'aria-label': `重试${destinationName(destination)}填写` },
        });
        retry.onclick = () => void this.handoffDestinations([destination]);
      }
    }
  }

  private handoffButton(
    parent: HTMLElement,
    draft: ImagePostDraft,
    label: string,
    destinations: readonly ImagePostDestination[],
    primary = false,
  ): void {
    const button = parent.createEl('button', {
      cls: primary ? 'mod-cta' : undefined,
      text: label,
      attr: { type: 'button' },
    });
    button.disabled = this.busy
      || !draft.materials.length
      || destinations.some(destination => this.destinationRuns[destination].status === 'running');
    button.onclick = () => void this.handoffDestinations(destinations);
  }

  private async choosePhotos(): Promise<void> {
    const input = document.body.createEl('input', { type: 'file' });
    input.accept = 'image/jpeg,image/png,image/webp,.heic,.heif'; input.multiple = true; input.hidden = true;
    input.onchange = () => { const files = input.files; input.remove(); void this.importFiles(files); };
    input.click();
  }

  private async chooseReplacement(materialId: string): Promise<void> {
    if (!this.draft || this.busy) return;
    const input = document.body.createEl('input', { type: 'file' });
    input.accept = 'image/jpeg,image/png,image/webp,.heic,.heif';
    input.hidden = true;
    input.onchange = () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void this.replaceMaterial(materialId, file);
    };
    input.click();
  }

  private async replaceMaterial(materialId: string, file: File): Promise<void> {
    if (!this.draft || this.busy) return;
    const index = this.draft.materials.findIndex(material => material.id === materialId);
    if (index < 0) return;
    this.busy = true;
    this.status = '正在重新选择图文素材…';
    this.error = '';
    this.deps.requestRender();
    try {
      const sourcePath = electronWebUtils?.getPathForFile(file) || (file as File & { path?: string }).path;
      if (!sourcePath) throw new Error(`无法读取“${file.name}”的本地路径。`);
      const material = await this.deps.workspace.importPhoto({
        sourcePath,
        originalName: file.name,
        ...await imageDimensions(file),
      });
      const materials = [...this.draft.materials];
      materials[index] = material;
      const next = {
        ...this.draft,
        materials,
        leadMaterialId: this.draft.leadMaterialId === materialId
          ? material.id
          : this.draft.leadMaterialId,
      };
      this.previewStore.release(materialId);
      this.materialPreviews.delete(materialId);
      this.draft = next;
      await this.deps.workspace.saveDraft(next);
      this.status = '已替换无法读取的素材。';
    } catch (error) {
      this.error = error instanceof Error ? error.message : '重新选择图片失败。';
    } finally {
      this.busy = false;
      if (!this.disposed) this.deps.requestRender();
    }
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

  private async handoffDestinations(destinations: readonly ImagePostDestination[]): Promise<void> {
    await Promise.all(destinations.map(destination => this.handoffDestination(destination)));
  }

  private async handoffDestination(destination: ImagePostDestination): Promise<void> {
    if (!this.draft || this.busy || this.destinationRuns[destination].status === 'running') return;
    const abort = new AbortController();
    this.destinationRuns[destination] = {
      status: 'running',
      message: `正在打开${destinationName(destination)}后台…`,
      abort,
    };
    this.error = '';
    this.deps.requestRender();
    try {
      const prepared = prepareImagePost(this.draft, [destination]);
      const results = await this.deps.workspace.handoff(prepared, {
        signal: abort.signal,
        onProgress: progress => {
          const active = this.destinationRuns[destination];
          if (active.abort !== abort) return;
          this.destinationRuns[destination] = { ...active, message: progress.message };
          if (!this.disposed) this.deps.requestRender();
        },
      });
      const outcome = results[destination]?.outcomes[destination];
      const message = outcome?.message || `${destinationName(destination)}后台填写结束，请在 Chrome 中检查。`;
      const status = outcome?.status === 'editor-filled'
        ? 'succeeded'
        : outcome?.status === 'attention-required'
          ? 'attention'
          : outcome?.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
      this.destinationRuns[destination] = { status, message, abort: null };
      new Notice(message, 10_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : `${destinationName(destination)}后台填写失败。`;
      this.destinationRuns[destination] = {
        status: abort.signal.aborted ? 'cancelled' : 'failed',
        message,
        abort: null,
      };
      new Notice(message, 10_000);
    } finally {
      const active = this.destinationRuns[destination];
      if (active.abort === abort) this.destinationRuns[destination] = { ...active, abort: null };
      if (!this.disposed) this.deps.requestRender();
    }
  }

  private materialButton(parent: HTMLElement, icon: string, label: string, action: () => void, disabled = false): void {
    const button = parent.createEl('button', { attr: { type: 'button', title: label, 'aria-label': label } });
    setIcon(button, icon); button.disabled = disabled || this.busy; button.onclick = event => { event.stopPropagation(); action(); };
  }
  private moveMaterial(id: string, index: number): void { if (this.draft) { this.draft = moveImagePostMaterial(this.draft, id, index); void this.persistAndRender(); } }
  private setLead(id: string): void { if (this.draft) { this.draft = setImagePostLeadMaterial(this.draft, id); void this.persistAndRender(); } }
  private removeMaterial(id: string): void {
    if (!this.draft) return;
    this.previewStore.release(id);
    this.materialPreviews.delete(id);
    this.draft = removeImagePostMaterial(this.draft, id);
    void this.persistAndRender();
  }
  private async persistAndRender(): Promise<void> { if (this.draft) await this.deps.workspace.saveDraft(this.draft); if (!this.disposed) this.deps.requestRender(); }
}

class ImagePostMaterialPreviewModal extends Modal {
  private index: number;

  constructor(
    app: App,
    private readonly entries: readonly { material: ImagePostMaterial; url: string }[],
    initialIndex: number,
  ) {
    super(app);
    this.index = initialIndex;
  }

  onOpen(): void {
    this.modalEl.addClass('ailu-image-post-preview-modal');
    this.renderPreview();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderPreview(): void {
    this.contentEl.empty();
    const entry = this.entries[this.index];
    if (!entry) return;
    const header = this.contentEl.createDiv({ cls: 'ailu-image-post-preview-header' });
    header.createEl('strong', {
      text: entry.material.kind === 'photo'
        ? entry.material.originalName
        : entry.material.fileName,
    });
    header.createSpan({
      text: `${this.index + 1}/${this.entries.length} · ${entry.material.width}×${entry.material.height}`,
    });
    this.contentEl.createEl('img', {
      cls: 'ailu-image-post-preview-large',
      attr: { src: entry.url, alt: entry.material.fileName },
    });
    const navigation = this.contentEl.createDiv({ cls: 'ailu-image-post-preview-navigation' });
    const previous = navigation.createEl('button', {
      attr: { type: 'button', 'aria-label': '上一张图片' },
    });
    setIcon(previous, 'chevron-left');
    previous.disabled = this.index === 0;
    previous.onclick = () => { this.index -= 1; this.renderPreview(); };
    const next = navigation.createEl('button', {
      attr: { type: 'button', 'aria-label': '下一张图片' },
    });
    setIcon(next, 'chevron-right');
    next.disabled = this.index === this.entries.length - 1;
    next.onclick = () => { this.index += 1; this.renderPreview(); };
  }
}

function destinationName(destination: ImagePostDestination): string {
  return destination === 'rednote' ? '小红书' : '微信贴图';
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
