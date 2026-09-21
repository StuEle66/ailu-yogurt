import { createHash } from 'node:crypto';

import { Notice, setIcon, type App, type TFile } from 'obsidian';

import {
  addImagePostMaterial,
  importImagePostPhotoFileBatch,
  ManagedImagePostPreviewStore,
  moveImagePostMaterial,
  prepareImagePost,
  replaceImagePostMaterials,
  removeImagePostMaterial,
  replaceImagePostMaterial,
  resetDestinationImagePostCopy,
  setDestinationImagePostCopy,
  setImagePostActiveMaterial,
  setImagePostLeadMaterial,
  setImagePostSelectedCardPages,
  updateSharedImagePostCopy,
  readImagePostPhotoFile,
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
  mode: 'cards' | 'photos';
}

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
  private legacyDraft: ImagePostDraft | null = null;
  private backupDraft: ImagePostDraft | null = null;
  private saveTimer: number | null = null;
  private readonly destinationRuns: Record<ImagePostDestination, DestinationRunState> = {
    rednote: { status: 'idle', message: '', abort: null },
    'wechat-image': { status: 'idle', message: '', abort: null },
  };
  private disposed = false;

  constructor(private readonly deps: ImagePostPublishingPanelDeps) {
    this.previewStore = new ManagedImagePostPreviewStore({
      readMaterial: material => deps.workspace.readMaterialBytes(material),
    });
    this.cards = deps.mode === 'cards' && deps.file ? new RedNotePublishingPanel({
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
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    void this.flushDraftSave();
    this.previewStore.dispose();
    this.materialPreviews.clear();
    for (const run of Object.values(this.destinationRuns)) run.abort?.abort();
    this.cards?.dispose();
  }

  async render(parent: HTMLElement): Promise<void> {
    if (!this.draft && !this.loading) void this.load();
    const root = parent.createDiv({ cls: 'ailu-image-post-panel' });
    if (this.deps.mode === 'cards') {
      if (this.cards) await this.cards.render(root);
      await this.renderCardComposer(root);
      return;
    }
    const composer = root.createDiv({ cls: 'ailu-image-post-composer is-photo-workspace' });
    const header = composer.createDiv({ cls: 'ailu-image-post-composer-header' });
    const heading = header.createDiv();
    heading.createEl('h3', { text: '图文草稿' });
    heading.createEl('p', { text: '选择照片，填写文案，再填入小红书和微信贴图后台。' });
    const importButton = header.createEl('button', { attr: { type: 'button' } });
    setIcon(importButton.createSpan(), 'images');
    importButton.createSpan({ text: this.draft?.materials.length ? '继续添加' : '选择照片' });
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

    this.renderLegacyRecovery(composer);
    this.renderPhotoWorkspace(composer, draft);
    this.renderCopyEditor(composer, draft);
    this.renderDestinations(composer, draft);
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.deps.requestRender();
    try {
      const source = this.deps.mode === 'cards' && this.deps.file
        ? await readRedNoteSource(this.deps.app, this.deps.file)
        : '';
      const identity = this.deps.file ? {
        articlePath: this.deps.file.path,
        contentVersion: createHash('sha256').update(source, 'utf8').digest('hex'),
      } : null;
      const draft = await this.deps.workspace.loadDraft(
        this.deps.mode === 'cards' ? identity : null,
        this.deps.mode,
      );
      if (this.deps.mode === 'cards' && identity) draft.source = identity;
      if (this.deps.mode === 'cards' && !draft.sharedCopy.title && this.deps.file) {
        draft.sharedCopy.title = this.deps.file.basename;
      }
      this.draft = draft;
      if (this.deps.mode === 'photos') {
        this.legacyDraft = identity ? await this.deps.workspace.loadLegacyPhotoDraft(identity) : null;
        this.backupDraft = await this.deps.workspace.loadStandalonePhotoDraftBackup();
      }
      await this.deps.workspace.saveDraft(draft);
    } catch (error) { this.error = error instanceof Error ? error.message : '图文草稿恢复失败。'; }
    finally { this.loading = false; if (!this.disposed) this.deps.requestRender(); }
  }

  private async renderCardComposer(root: HTMLElement): Promise<void> {
    const composer = root.createDiv({ cls: 'ailu-image-post-composer is-card-handoff' });
    if (this.loading) {
      composer.createDiv({ cls: 'ailu-rednote-inline-status', text: '正在恢复图卡文案…' });
      return;
    }
    if (this.error) composer.createDiv({ cls: 'ailu-rednote-inline-status is-error', text: this.error });
    if (this.status) composer.createDiv({ cls: 'ailu-rednote-inline-status', text: this.status });
    const draft = this.draft;
    if (!draft || !this.cards) return;
    const pageCount = this.cards.pageCount();
    const validSelection = draft.selectedCardPages.filter(page => page <= pageCount);
    if (pageCount > 0 && validSelection.length === 0 && draft.selectedCardPages.length === 0) {
      this.draft = setImagePostSelectedCardPages(draft, Array.from({ length: pageCount }, (_, index) => index + 1));
      await this.persistAndRender();
      return;
    }
    if (validSelection.length !== draft.selectedCardPages.length) {
      this.draft = setImagePostSelectedCardPages(draft, validSelection);
      await this.persistAndRender();
      return;
    }
    const selection = composer.createDiv({ cls: 'ailu-image-post-card-selection' });
    const summary = selection.createDiv({ cls: 'ailu-image-post-card-selection-summary' });
    summary.createEl('strong', { text: '后台填入页面' });
    summary.createSpan({ text: pageCount ? `已选 ${validSelection.length}/${pageCount} 页` : '等待生成图卡' });
    const pages = selection.createDiv({ cls: 'ailu-image-post-card-pages' });
    for (let page = 1; page <= pageCount; page += 1) {
      const label = pages.createEl('label');
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.checked = validSelection.includes(page);
      checkbox.disabled = this.isBusy();
      label.createSpan({ text: String(page).padStart(2, '0') });
      checkbox.onchange = () => {
        if (!this.draft) return;
        const next = new Set(this.draft.selectedCardPages);
        if (checkbox.checked) next.add(page); else next.delete(page);
        this.draft = setImagePostSelectedCardPages(this.draft, [...next]);
        void this.persistAndRender();
      };
    }
    this.renderCopyEditor(composer, draft);
    this.renderDestinations(composer, draft);
  }

  private renderLegacyRecovery(parent: HTMLElement): void {
    if (!this.legacyDraft && !this.backupDraft) return;
    const recovery = parent.createEl('details', { cls: 'ailu-image-post-recovery' });
    recovery.createEl('summary', { text: '恢复旧照片草稿' });
    if (this.legacyDraft) {
      const row = recovery.createDiv({ cls: 'ailu-image-post-recovery-row' });
      row.createSpan({ text: `当前文章有旧草稿（${this.legacyDraft.materials.length} 张照片）` });
      const restore = row.createEl('button', { text: '复制到独立草稿', attr: { type: 'button' } });
      restore.onclick = () => void this.restoreLegacyDraft();
    }
    if (this.backupDraft) {
      const row = recovery.createDiv({ cls: 'ailu-image-post-recovery-row' });
      row.createSpan({ text: `恢复前版本（${this.backupDraft.materials.length} 张照片）` });
      const restore = row.createEl('button', { text: '恢复此版本', attr: { type: 'button' } });
      restore.onclick = () => void this.restorePhotoBackup();
    }
  }

  private renderPhotoWorkspace(parent: HTMLElement, draft: ImagePostDraft): void {
    this.previewStore.retain(draft.materials);
    const activeIds = new Set(draft.materials.map(material => material.id));
    for (const id of this.materialPreviews.keys()) {
      if (!activeIds.has(id)) this.materialPreviews.delete(id);
    }
    const workspace = parent.createDiv({ cls: 'ailu-image-post-photo-workspace' });
    workspace.ondragover = event => { event.preventDefault(); workspace.addClass('is-dragging'); };
    workspace.ondragleave = () => workspace.removeClass('is-dragging');
    workspace.ondrop = event => {
      event.preventDefault();
      workspace.removeClass('is-dragging');
      void this.importFiles(event.dataTransfer?.files ?? null);
    };
    if (!draft.materials.length) {
      const empty = workspace.createEl('button', {
        cls: 'ailu-image-post-photo-empty',
        attr: { type: 'button', 'aria-label': '选择或拖入照片' },
      });
      setIcon(empty.createSpan(), 'images');
      empty.createEl('strong', { text: '选择或拖入照片' });
      empty.createSpan({ text: '支持 JPEG、PNG、WebP、DNG、HEIC，可一次选择多张' });
      empty.onclick = () => void this.choosePhotos();
      return;
    }

    const activeIndex = Math.max(0, draft.materials.findIndex(material => (
      material.id === draft.activeMaterialId
    )));
    const active = draft.materials[activeIndex];
    const preview = this.ensureMaterialPreview(active);
    const stage = workspace.createDiv({ cls: 'ailu-image-post-photo-stage' });
    if (preview?.status === 'ready' && preview.url) {
      stage.createEl('img', {
        attr: { src: preview.url, alt: active.kind === 'photo' ? active.originalName : active.fileName },
      });
    } else if (preview?.status === 'error') {
      const failure = stage.createDiv({ cls: 'ailu-image-post-photo-error' });
      setIcon(failure.createSpan(), 'image-off');
      failure.createEl('strong', { text: '图片无法读取' });
      failure.createSpan({ text: preview.message });
      const retry = failure.createEl('button', { text: '重新选择', attr: { type: 'button' } });
      retry.onclick = () => void this.chooseReplacement(active.id);
    } else {
      stage.createDiv({ cls: 'ailu-image-post-material-placeholder', text: '正在读取图片…' });
    }

    const navigation = workspace.createDiv({ cls: 'ailu-image-post-photo-navigation' });
    const previous = navigation.createEl('button', { attr: { type: 'button', 'aria-label': '上一张照片' } });
    setIcon(previous, 'chevron-left');
    previous.disabled = activeIndex === 0;
    previous.onclick = () => this.selectMaterial(draft.materials[activeIndex - 1]?.id);
    navigation.createSpan({ text: `${activeIndex + 1}/${draft.materials.length}` });
    const next = navigation.createEl('button', { attr: { type: 'button', 'aria-label': '下一张照片' } });
    setIcon(next, 'chevron-right');
    next.disabled = activeIndex === draft.materials.length - 1;
    next.onclick = () => this.selectMaterial(draft.materials[activeIndex + 1]?.id);

    const details = workspace.createDiv({ cls: 'ailu-image-post-photo-current' });
    details.createEl('strong', { text: active.kind === 'photo' ? active.originalName : active.fileName });
    details.createSpan({ text: `${active.width}×${active.height}${active.id === draft.leadMaterialId ? ' · 首图' : ''}` });
    const actions = details.createDiv({ cls: 'ailu-image-post-material-actions' });
    this.materialButton(actions, 'arrow-left', '前移', () => this.moveMaterial(active.id, activeIndex - 1), activeIndex === 0);
    this.materialButton(actions, 'arrow-right', '后移', () => this.moveMaterial(active.id, activeIndex + 1), activeIndex === draft.materials.length - 1);
    this.materialButton(actions, 'star', '设为首图', () => this.setLead(active.id), active.id === draft.leadMaterialId);
    this.materialButton(actions, 'x', '移除', () => this.removeMaterial(active.id));

    const thumbnails = workspace.createDiv({ cls: 'ailu-image-post-photo-thumbnails' });
    draft.materials.forEach((material, index) => {
      const thumbnailPreview = this.ensureMaterialPreview(material);
      const button = thumbnails.createEl('button', {
        cls: material.id === active.id ? 'is-active' : undefined,
        attr: { type: 'button', 'aria-label': `查看第 ${index + 1} 张照片` },
      });
      if (thumbnailPreview?.status === 'ready' && thumbnailPreview.url) {
        button.createEl('img', { attr: { src: thumbnailPreview.url, alt: material.fileName } });
      } else {
        setIcon(button, thumbnailPreview?.status === 'error' ? 'image-off' : 'image');
      }
      button.createSpan({ text: String(index + 1) });
      button.onclick = () => this.selectMaterial(material.id);
    });
  }

  private ensureMaterialPreview(material: ImagePostMaterial): MaterialPreviewState | undefined {
    const preview = this.materialPreviews.get(material.id);
    if (!preview || preview.contentHash !== material.contentHash) this.loadMaterialPreview(material);
    return this.materialPreviews.get(material.id);
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

  private renderCopyEditor(parent: HTMLElement, draft: ImagePostDraft): void {
    const section = parent.createDiv({ cls: 'ailu-image-post-copy' });
    section.createEl('h4', { text: '发布文案' });
    this.renderCopyFields(section, draft.sharedCopy, copy => {
      if (!this.draft) return;
      this.draft = updateSharedImagePostCopy(this.draft, copy);
      this.scheduleDraftSave();
    });
    const overrides = section.createEl('details', { cls: 'ailu-image-post-overrides' });
    overrides.createEl('summary', { text: '分别调整平台文案' });
    for (const destination of ['rednote', 'wechat-image'] as const) {
      const label = destination === 'rednote' ? '小红书单独调整' : '微信贴图单独调整';
      const enabled = Boolean(draft.destinationCopy[destination]);
      const row = overrides.createEl('label');
      const toggle = row.createEl('input', { type: 'checkbox' });
      toggle.checked = enabled;
      row.createSpan({ text: label });
      toggle.onchange = () => {
        if (!this.draft) return;
        this.draft = toggle.checked
          ? setDestinationImagePostCopy(this.draft, destination, this.draft.sharedCopy)
          : resetDestinationImagePostCopy(this.draft, destination);
        void this.persistAndRender();
      };
      if (enabled) this.renderCopyFields(overrides, draft.destinationCopy[destination]!, copy => {
        if (!this.draft) return;
        this.draft = setDestinationImagePostCopy(this.draft, destination, copy);
        this.scheduleDraftSave();
      }, destination === 'rednote' ? '小红书' : '微信贴图');
    }
  }

  private renderCopyFields(parent: HTMLElement, copy: ImagePostCopy, onChange: (copy: ImagePostCopy) => void, prefix = ''): void {
    const fields = parent.createDiv({ cls: 'ailu-image-post-copy-fields' });
    const titleLabel = fields.createEl('label');
    titleLabel.createSpan({ text: `${prefix ? `${prefix} ` : ''}标题` });
    const title = titleLabel.createEl('input', { type: 'text', value: copy.title, attr: { placeholder: '填写标题', 'aria-label': `${prefix || '共用'}标题` } });
    const bodyLabel = fields.createEl('label');
    bodyLabel.createSpan({ text: `${prefix ? `${prefix} ` : ''}文案` });
    const body = bodyLabel.createEl('textarea', { attr: { placeholder: '填写正文文案', 'aria-label': `${prefix || '共用'}文案` } });
    body.value = copy.body;
    const topicsLabel = fields.createEl('label');
    topicsLabel.createSpan({ text: `${prefix ? `${prefix} ` : ''}话题 tag` });
    const topics = topicsLabel.createEl('input', { type: 'text', value: copy.topics.join(' '), attr: { placeholder: '#AI #工作流', 'aria-label': `${prefix || '共用'}话题` } });
    const update = (): void => onChange({
      title: title.value,
      body: body.value,
      topics: topics.value.split(/\s+/u).map(value => value.replace(/^#+/u, '')).filter(Boolean),
    });
    title.oninput = update; body.oninput = update; topics.oninput = update;
    title.onchange = () => void this.flushDraftSave();
    body.onchange = () => void this.flushDraftSave();
    topics.onchange = () => void this.flushDraftSave();
  }

  private renderDestinations(parent: HTMLElement, draft: ImagePostDraft): void {
    const footer = parent.createDiv({ cls: 'ailu-image-post-handoff' });
    const actions = footer.createDiv({ cls: 'ailu-image-post-handoff-actions' });
    this.handoffButton(actions, draft, '一键填入双平台', ['rednote', 'wechat-image'], true);
    this.handoffButton(actions, draft, '填入小红书', ['rednote']);
    this.handoffButton(actions, draft, '填入微信贴图', ['wechat-image']);
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
    const utilities = footer.createDiv({ cls: 'ailu-image-post-handoff-utilities' });
    for (const destination of ['rednote', 'wechat-image'] as const) {
      const open = utilities.createEl('button', {
        text: `打开${destinationName(destination)}后台`,
        attr: { type: 'button' },
      });
      open.onclick = () => void this.openDestination(destination);
    }
    const diagnostic = utilities.createEl('button', {
      text: '复制诊断摘要',
      attr: { type: 'button' },
    });
    diagnostic.onclick = () => void this.copyDiagnosticSummary(draft);
  }

  private async openDestination(destination: ImagePostDestination): Promise<void> {
    try {
      await this.deps.workspace.openDestination(destination);
      new Notice(`${destinationName(destination)}后台已在专用 Chrome 中打开。`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : '无法打开专用 Chrome。');
    }
  }

  private async copyDiagnosticSummary(draft: ImagePostDraft): Promise<void> {
    const lines = [
      `Ailu 图文诊断`,
      `工作区：${draft.workflow}`,
      `修订：${draft.revision}`,
      `图片：${draft.workflow === 'cards' ? draft.selectedCardPages.length : draft.materials.length}`,
      ...(['rednote', 'wechat-image'] as const).map(destination => {
        const run = this.destinationRuns[destination];
        return `${destinationName(destination)}：${run.status}${run.message ? ` · ${run.message}` : ''}`;
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      new Notice('图文诊断摘要已复制，不包含文案、Cookie 或图片内容。');
    } catch {
      new Notice('复制诊断摘要失败，请检查系统剪贴板权限。');
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
    const materialCount = this.deps.mode === 'cards'
      ? draft.selectedCardPages.length
      : draft.materials.length;
    const limitExceeded = destinations.some(destination => materialCount > imagePostLimit(destination));
    button.disabled = this.busy
      || materialCount === 0
      || limitExceeded
      || destinations.some(destination => this.destinationRuns[destination].status === 'running');
    if (limitExceeded) button.title = `所选图片超过平台上限，请减少后重试。`;
    button.onclick = () => void this.handoffDestinations(destinations);
  }

  private async choosePhotos(): Promise<void> {
    const input = document.body.createEl('input', { type: 'file' });
    input.accept = 'image/jpeg,image/png,image/webp,.dng,.heic,.heif'; input.multiple = true; input.hidden = true;
    input.onchange = () => { const files = input.files; input.remove(); void this.importFiles(files); };
    input.oncancel = () => input.remove();
    input.click();
  }

  private async chooseReplacement(materialId: string): Promise<void> {
    if (!this.draft || this.busy) return;
    const input = document.body.createEl('input', { type: 'file' });
    input.accept = 'image/jpeg,image/png,image/webp,.dng,.heic,.heif';
    input.hidden = true;
    input.onchange = () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void this.replaceMaterial(materialId, file);
    };
    input.oncancel = () => input.remove();
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
      const result = await this.deps.workspace.importPhotoSource(await readImagePostPhotoFile(file));
      const material = result.material;
      const next = replaceImagePostMaterial(this.draft, materialId, material);
      this.previewStore.release(materialId);
      this.materialPreviews.delete(materialId);
      this.draft = next;
      await this.deps.workspace.saveDraft(next);
      this.status = result.converted
        ? '已转换并替换照片，原始照片没有修改。'
        : '已替换无法读取的素材。';
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
      const batch = await importImagePostPhotoFileBatch(
        Array.from(files),
        input => this.deps.workspace.importPhotoSource(input),
      );
      const convertedFormats = new Map<string, number>();
      for (const { result } of batch.imported) {
        next = addImagePostMaterial(next, result.material);
        if (result.converted) {
          const label = result.sourceFormat.toUpperCase();
          convertedFormats.set(label, (convertedFormats.get(label) ?? 0) + 1);
        }
      }
      const imported = batch.imported.length;
      this.draft = next;
      if (imported) await this.deps.workspace.saveDraft(next);
      const convertedSummary = [...convertedFormats]
        .map(([format, count]) => `${count} 张 ${format}`)
        .join('、');
      this.status = imported
        ? `已加入 ${imported} 张照片${convertedSummary ? `，其中 ${convertedSummary} 已自动转换为 JPEG` : ''}。`
        : '';
      if (batch.failures.length) this.error = batch.failures.join(' ');
    } catch (error) { this.error = error instanceof Error ? error.message : '照片导入失败。'; }
    finally { this.busy = false; if (!this.disposed) this.deps.requestRender(); }
  }

  private async handoffDestinations(destinations: readonly ImagePostDestination[]): Promise<void> {
    if (!this.draft || this.busy) return;
    await this.flushDraftSave();
    if (this.deps.mode === 'cards') {
      const strictestLimit = Math.min(...destinations.map(imagePostLimit));
      if (this.draft.selectedCardPages.length > strictestLimit) {
        this.error = `所选图片超过平台上限 ${strictestLimit} 张，请减少后重试。`;
        this.deps.requestRender();
        return;
      }
      await this.materializeSelectedCards(destinations[0]);
    }
    if (!this.draft) return;
    const prepared = new Map(destinations.map(destination => (
      [destination, prepareImagePost(this.draft!, [destination])] as const
    )));
    await Promise.all(destinations.map(destination => (
      this.handoffDestination(destination, prepared.get(destination))
    )));
  }

  private async handoffDestination(
    destination: ImagePostDestination,
    preparedSnapshot?: ReturnType<typeof prepareImagePost>,
  ): Promise<void> {
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
      if (!this.draft) throw new Error('图卡发送快照尚未准备好。');
      const prepared = preparedSnapshot ?? prepareImagePost(this.draft, [destination]);
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

  private async materializeSelectedCards(destination: ImagePostDestination): Promise<void> {
    if (!this.cards || !this.draft) throw new Error('当前文章没有可发送的图卡。');
    const selected = new Set(this.draft.selectedCardPages);
    if (!selected.size) throw new Error('请至少选择一页图卡。');
    if (selected.size > imagePostLimit(destination)) {
      throw new Error(`${destinationName(destination)}最多填入 ${imagePostLimit(destination)} 张图片，请减少图卡页数。`);
    }
    this.status = '正在冻结所选图卡…';
    this.deps.requestRender();
    const rendered = await this.cards.renderImagesForPost();
    const cards: ImagePostMaterial[] = [];
    for (let index = 0; index < rendered.length; index += 1) {
      const page = index + 1;
      if (!selected.has(page)) continue;
      cards.push(await this.deps.workspace.importRenderedCard({
        bytes: new Uint8Array(await rendered[index].blob.arrayBuffer()),
        fileName: rendered[index].fileName,
        page,
        width: 1800,
        height: 2400,
      }));
    }
    this.draft = replaceImagePostMaterials(this.draft, cards);
    await this.deps.workspace.saveDraft(this.draft);
    this.status = `已冻结 ${cards.length} 页图卡。`;
  }

  private materialButton(parent: HTMLElement, icon: string, label: string, action: () => void, disabled = false): void {
    const button = parent.createEl('button', { attr: { type: 'button', title: label, 'aria-label': label } });
    setIcon(button, icon); button.disabled = disabled || this.busy; button.onclick = event => { event.stopPropagation(); action(); };
  }
  private selectMaterial(id: string | undefined): void {
    if (!this.draft || !id) return;
    this.draft = setImagePostActiveMaterial(this.draft, id);
    void this.persistAndRender();
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
  private async restoreLegacyDraft(): Promise<void> {
    if (!this.deps.file || this.busy) return;
    this.busy = true;
    this.error = '';
    try {
      const source = {
        articlePath: this.deps.file.path,
        contentVersion: createHash('sha256').update('', 'utf8').digest('hex'),
      };
      this.draft = await this.deps.workspace.restoreLegacyPhotoDraft(source);
      this.backupDraft = await this.deps.workspace.loadStandalonePhotoDraftBackup();
      this.status = '旧照片草稿已复制到独立工作区，原草稿仍保留。';
    } catch (error) {
      this.error = error instanceof Error ? error.message : '恢复旧照片草稿失败。';
    } finally {
      this.busy = false;
      if (!this.disposed) this.deps.requestRender();
    }
  }
  private async restorePhotoBackup(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    try {
      this.draft = await this.deps.workspace.restoreStandalonePhotoDraftBackup();
      this.status = '已恢复上次独立照片草稿。';
    } catch (error) {
      this.error = error instanceof Error ? error.message : '恢复照片草稿备份失败。';
    } finally {
      this.busy = false;
      if (!this.disposed) this.deps.requestRender();
    }
  }
  private scheduleDraftSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushDraftSave();
    }, 250);
  }
  private async flushDraftSave(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.draft) await this.deps.workspace.saveDraft(this.draft);
  }
  private async persistAndRender(): Promise<void> { if (this.draft) await this.deps.workspace.saveDraft(this.draft); if (!this.disposed) this.deps.requestRender(); }
}

function destinationName(destination: ImagePostDestination): string {
  return destination === 'rednote' ? '小红书' : '微信贴图';
}

function imagePostLimit(destination: ImagePostDestination): number {
  return destination === 'rednote' ? 18 : 20;
}
