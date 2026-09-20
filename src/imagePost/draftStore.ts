import path from 'node:path';

import type { ImagePostDraft } from './index';

export interface ImagePostDraftFileSystem {
  mkdir(path: string): Promise<void>;
  readFileIfExists(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
}

export class ImagePostDraftStore {
  private readonly directory: string;
  private readonly fileSystem: ImagePostDraftFileSystem;

  constructor(options: {
    directory: string;
    fileSystem: ImagePostDraftFileSystem;
  }) {
    this.directory = path.resolve(options.directory);
    this.fileSystem = options.fileSystem;
  }

  async save(draft: ImagePostDraft): Promise<void> {
    const normalized = normalizeDraft(draft);
    await this.fileSystem.mkdir(this.directory);
    const payload = JSON.stringify({ schemaVersion: 1, draft: normalized });
    await this.fileSystem.writeFile(
      this.pathForDraft(normalized.id),
      new TextEncoder().encode(payload),
    );
  }

  async load(draftId: string): Promise<ImagePostDraft | null> {
    const filePath = this.pathForDraft(draftId);
    const bytes = await this.fileSystem.readFileIfExists(filePath);
    if (bytes === null) return null;
    try {
      const envelope: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(envelope) || envelope.schemaVersion !== 1) {
        throw new Error('不支持的草稿格式');
      }
      const draft = normalizeDraft(envelope.draft);
      if (draft.id !== draftId) throw new Error('草稿 ID 与文件名不一致');
      return draft;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`图文草稿“${draftId}”损坏：${reason}`, { cause: error });
    }
  }

  private pathForDraft(draftId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(draftId)) {
      throw new Error('图文草稿 ID 格式无效。');
    }
    return path.join(this.directory, `${draftId}.json`);
  }
}

function normalizeDraft(value: unknown): ImagePostDraft {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || !/^[a-zA-Z0-9_-]+$/u.test(value.id)) {
    throw new Error('草稿 ID 无效');
  }
  const source = value.source === null
    ? null
    : normalizeSource(value.source);
  if (!Array.isArray(value.materials)) throw new Error('素材列表无效');
  const workflow: ImagePostDraft['workflow'] = value.workflow === 'cards' ? 'cards' : 'photos';
  const revision = typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision >= 0
    ? value.revision : 0;
  const normalizedMaterials = value.materials.map(normalizeMaterial);
  const materials = normalizedMaterials.filter(material => material.kind === (workflow === 'cards' ? 'card' : 'photo'));
  const ids = new Set(materials.map(material => material.id));
  if (ids.size !== materials.length) throw new Error('素材 ID 重复');
  const leadMaterialId = materials.some(material => material.id === value.leadMaterialId)
    ? value.leadMaterialId : materials[0]?.id ?? null;
  if (leadMaterialId !== null && typeof leadMaterialId !== 'string') {
    throw new Error('首图 ID 无效');
  }
  if ((materials.length === 0) !== (leadMaterialId === null)
    || (leadMaterialId !== null && !ids.has(leadMaterialId))) {
    throw new Error('首图引用无效');
  }
  const sharedCopy = normalizeCopy(value.sharedCopy);
  if (!isRecord(value.destinationCopy)) throw new Error('平台文案无效');
  const destinationCopy: ImagePostDraft['destinationCopy'] = {};
  if (value.destinationCopy.rednote !== undefined) {
    destinationCopy.rednote = normalizeCopy(value.destinationCopy.rednote);
  }
  if (value.destinationCopy['wechat-image'] !== undefined) {
    destinationCopy['wechat-image'] = normalizeCopy(value.destinationCopy['wechat-image']);
  }
  const selectedCardPages = workflow === 'cards' && Array.isArray(value.selectedCardPages)
    ? [...new Set(value.selectedCardPages.filter((page): page is number => (
        typeof page === 'number' && Number.isInteger(page) && page > 0
      )))].sort((left, right) => left - right)
    : [];
  return {
    id: value.id,
    workflow,
    revision,
    source,
    materials,
    leadMaterialId,
    sharedCopy,
    destinationCopy,
    selectedCardPages,
  };
}

function normalizeSource(value: unknown): NonNullable<ImagePostDraft['source']> {
  if (!isRecord(value)
    || typeof value.articlePath !== 'string'
    || typeof value.contentVersion !== 'string') {
    throw new Error('来源文章信息无效');
  }
  return { articlePath: value.articlePath, contentVersion: value.contentVersion };
}

function normalizeMaterial(value: unknown): ImagePostDraft['materials'][number] {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.fileName !== 'string'
    || typeof value.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.contentHash)
    || typeof value.width !== 'number'
    || !Number.isFinite(value.width)
    || value.width <= 0
    || typeof value.height !== 'number'
    || !Number.isFinite(value.height)
    || value.height <= 0
    || typeof value.managedPath !== 'string'
    || !value.managedPath
    || value.managedPath.startsWith('blob:')
    || !isImageMimeType(value.mimeType)) {
    throw new Error('素材元数据无效');
  }
  const base = {
    id: value.id,
    fileName: value.fileName,
    contentHash: value.contentHash,
    width: value.width,
    height: value.height,
    managedPath: value.managedPath,
    mimeType: value.mimeType,
  };
  if (value.kind === 'card'
    && typeof value.renderedPage === 'number'
    && Number.isInteger(value.renderedPage)
    && value.renderedPage > 0) {
    return { ...base, kind: 'card', renderedPage: value.renderedPage };
  }
  if (value.kind === 'photo' && typeof value.originalName === 'string' && value.originalName) {
    return { ...base, kind: 'photo', originalName: value.originalName };
  }
  throw new Error('素材类型无效');
}

function normalizeCopy(value: unknown): ImagePostDraft['sharedCopy'] {
  if (!isRecord(value)
    || typeof value.title !== 'string'
    || typeof value.body !== 'string'
    || !Array.isArray(value.topics)
    || !value.topics.every(topic => typeof topic === 'string')) {
    throw new Error('图文文案无效');
  }
  return { title: value.title, body: value.body, topics: [...value.topics] };
}

function isImageMimeType(value: unknown): value is ImagePostDraft['materials'][number]['mimeType'] {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
