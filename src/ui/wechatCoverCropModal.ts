import { App, Modal } from 'obsidian';
import { coverCrop, COVER_HEIGHT, COVER_WIDTH } from './wechatCoverCrop';

/** Local decoding and canvas export never modify or upload the selected photograph. */
export class WeChatCoverCropModal extends Modal {
  private image: HTMLImageElement | null = null;
  private objectUrl: string | null = null;
  private zoom = 1;
  private x = 0.5;
  private y = 0.5;
  private disposed = false;
  private saving = false;

  constructor(app: App, private readonly file: File,
    private readonly onConfirm: (jpeg: ArrayBuffer) => Promise<void>,
    private readonly onFinished?: () => void) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('ailu-cover-crop-modal');
    this.contentEl.createEl('h2', { text: '裁剪公众号封面' });
    const status = this.contentEl.createDiv({ cls: 'ailu-cover-crop-status', text: '正在读取图片…' });
    void this.load(status);
  }

  private async load(status: HTMLElement): Promise<void> {
    try {
      if (!/\.(jpe?g|png|webp|heic|heif)$/i.test(this.file.name)) {
        throw new Error('请选择 JPG、PNG 或 WebP 图片。HEIC 请先从照片应用导出 JPEG。');
      }
      if (this.file.size === 0 || this.file.size > 50 * 1024 * 1024) throw new Error('图片为空或超过 50 MB。');
      this.objectUrl = URL.createObjectURL(this.file);
      const image = new Image();
      image.src = this.objectUrl;
      try { await image.decode(); } catch {
        throw new Error(/\.hei[cf]$/i.test(this.file.name)
          ? '系统无法解码 HEIC，请先从照片应用导出 JPEG。'
          : '图片无法解码，可能已损坏。请选择另一张 JPG、PNG 或 WebP 图片。');
      }
      if (this.disposed) return;
      if (image.naturalWidth * image.naturalHeight > 100_000_000) throw new Error('图片像素过大，请缩小后重试。');
      this.image = image;
      status.setText('2.35:1 · 拖动调整位置，缩放调整取景。原照片保持不变。');
      this.renderControls(status);
    } catch (error) {
      if (!this.disposed) status.setText(error instanceof Error ? error.message : '无法读取图片。');
    }
  }

  private renderControls(status: HTMLElement): void {
    const canvas = this.contentEl.createEl('canvas', { cls: 'ailu-cover-crop-canvas' });
    canvas.width = COVER_WIDTH;
    canvas.height = COVER_HEIGHT;
    canvas.setAttribute('aria-label', '封面裁剪预览，拖动调整图片位置');
    const draw = (): void => {
      if (!this.image) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('当前系统无法创建图片画布。');
      const rect = coverCrop(this.image.naturalWidth, this.image.naturalHeight, this.zoom, this.x, this.y);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
      ctx.drawImage(this.image, rect.x, rect.y, rect.width, rect.height, 0, 0, COVER_WIDTH, COVER_HEIGHT);
    };
    const zoomLabel = this.contentEl.createEl('label', { text: '缩放' });
    const slider = zoomLabel.createEl('input', { type: 'range' });
    slider.min = '1'; slider.max = '5'; slider.step = '0.01'; slider.value = '1';
    slider.setAttribute('aria-label', '封面缩放');
    slider.addEventListener('input', () => { if (!this.saving) { this.zoom = Number(slider.value); draw(); } });
    let drag: { id: number; x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', event => {
      if (this.saving) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId || !this.image || this.saving) return;
      const rect = coverCrop(this.image.naturalWidth, this.image.naturalHeight, this.zoom, this.x, this.y);
      const bounds = canvas.getBoundingClientRect();
      const dx = (event.clientX - drag.x) * rect.width / bounds.width;
      const dy = (event.clientY - drag.y) * rect.height / bounds.height;
      const roomX = this.image.naturalWidth - rect.width;
      const roomY = this.image.naturalHeight - rect.height;
      if (roomX > 0) this.x = Math.max(0, Math.min(1, this.x - dx / roomX));
      if (roomY > 0) this.y = Math.max(0, Math.min(1, this.y - dy / roomY));
      drag.x = event.clientX; drag.y = event.clientY; draw();
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    const buttons = this.contentEl.createDiv({ cls: 'ailu-cover-crop-actions' });
    const reset = buttons.createEl('button', { text: '重置' });
    reset.addEventListener('click', () => {
      this.zoom = 1; this.x = 0.5; this.y = 0.5; slider.value = '1'; draw();
    });
    const cancel = buttons.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const confirm = buttons.createEl('button', { text: '确认封面', cls: 'mod-cta' });
    confirm.addEventListener('click', () => {
      if (this.saving) return;
      this.saving = true;
      reset.disabled = cancel.disabled = confirm.disabled = slider.disabled = true;
      void (async () => {
        try {
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
            value => value ? resolve(value) : reject(new Error('封面导出失败。')), 'image/jpeg', 0.92));
          if (this.disposed) return;
          await this.onConfirm(await blob.arrayBuffer());
          this.saving = false;
          this.close();
        } catch (error) {
          status.setText(error instanceof Error ? error.message : '封面保存失败。');
        } finally {
          this.saving = false;
          reset.disabled = cancel.disabled = confirm.disabled = slider.disabled = false;
        }
      })();
    });
    draw();
  }

  close(): void {
    if (!this.saving) super.close();
  }

  onClose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.image = null;
    this.contentEl.empty();
    this.onFinished?.();
  }
}
