import type { ImagePostMaterial } from './index';

interface PreviewEntry {
  contentHash: string;
  promise: Promise<string>;
  url: string | null;
}

export class ManagedImagePostPreviewStore {
  private readonly entries = new Map<string, PreviewEntry>();
  private disposed = false;

  constructor(private readonly options: {
    readMaterial: (material: ImagePostMaterial) => Promise<Uint8Array>;
    createUrl?: (bytes: Uint8Array, mimeType: ImagePostMaterial['mimeType']) => string;
    revokeUrl?: (url: string) => void;
  }) {}

  load(material: ImagePostMaterial): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('图文素材预览已关闭。'));
    const cached = this.entries.get(material.id);
    if (cached?.contentHash === material.contentHash) return cached.promise;
    if (cached) this.release(material.id);

    const entry: PreviewEntry = {
      contentHash: material.contentHash,
      promise: Promise.resolve(''),
      url: null,
    };
    entry.promise = this.options.readMaterial(material).then(bytes => {
      const url = this.createUrl(bytes, material.mimeType);
      if (this.disposed || this.entries.get(material.id) !== entry) {
        this.revokeUrl(url);
        throw new Error('图文素材预览已失效。');
      }
      entry.url = url;
      return url;
    });
    this.entries.set(material.id, entry);
    return entry.promise;
  }

  retain(materials: readonly ImagePostMaterial[]): void {
    const retained = new Set(materials.map(material => material.id));
    for (const id of this.entries.keys()) {
      if (!retained.has(id)) this.release(id);
    }
  }

  release(materialId: string): void {
    const entry = this.entries.get(materialId);
    if (!entry) return;
    this.entries.delete(materialId);
    if (entry.url) this.revokeUrl(entry.url);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.entries.keys()]) this.release(id);
  }

  private createUrl(bytes: Uint8Array, mimeType: ImagePostMaterial['mimeType']): string {
    return this.options.createUrl?.(bytes, mimeType)
      ?? URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: mimeType }));
  }

  private revokeUrl(url: string): void {
    if (this.options.revokeUrl) this.options.revokeUrl(url);
    else URL.revokeObjectURL(url);
  }
}
