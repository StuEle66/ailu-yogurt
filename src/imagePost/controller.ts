import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createImagePostDraft,
  ImagePostDraftStore,
  ManagedImagePostAssetStore,
  type ImagePostDraft,
  type ImagePostDestination,
  type ImagePostMaterial,
  type ImagePostSource,
  type ImportImagePostPhotoBytesInput,
  type ImportImagePostPhotoInput,
  type ImportRenderedImagePostCardInput,
  type PreparedImagePost,
} from './index';
import {
  handoffPreparedImagePost,
  type ImagePostHandoffCoordinatorLike,
  type ImagePostHandoffOptions,
} from './workspaceService';
import { MacPhotoTranscoder } from './macPhotoTranscoder';
import {
  BrowserImagePostPhotoDimensionsReader,
  ImagePostPhotoNormalizer,
  type NormalizeImagePostPhotoInput,
} from './photoImport';

const nodeFileSystem = {
  mkdir: async (directory: string): Promise<void> => { await mkdir(directory, { recursive: true }); },
  readFile: async (filePath: string): Promise<Uint8Array> => readFile(filePath),
  readFileIfExists: async (filePath: string): Promise<Uint8Array | null> => {
    try { return await readFile(filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  writeFile: async (filePath: string, bytes: Uint8Array): Promise<void> => {
    await writeFile(filePath, bytes, { mode: 0o600 });
  },
};

const STANDALONE_PHOTO_DRAFT_ID = 'standalone';
const STANDALONE_PHOTO_BACKUP_ID = 'standalone_before_legacy_restore';

export class ImagePostWorkspaceController {
  private readonly drafts: ImagePostDraftStore;
  private readonly assets: ManagedImagePostAssetStore;
  private readonly photoNormalizer: ImagePostPhotoNormalizer;

  constructor(
    rootDirectory: string,
    private readonly coordinator: ImagePostHandoffCoordinatorLike,
    private readonly openDestinationEditor?: (
      destination: ImagePostDestination,
      signal: AbortSignal,
    ) => Promise<void>,
    photoNormalizer?: ImagePostPhotoNormalizer,
  ) {
    this.drafts = new ImagePostDraftStore({
      directory: path.join(rootDirectory, 'drafts'),
      fileSystem: nodeFileSystem,
    });
    this.assets = new ManagedImagePostAssetStore({
      rootDirectory: path.join(rootDirectory, 'assets'),
      fileSystem: nodeFileSystem,
      createId: () => randomUUID().replaceAll('-', ''),
    });
    this.photoNormalizer = photoNormalizer ?? new ImagePostPhotoNormalizer({
      transcoder: new MacPhotoTranscoder(),
      dimensions: new BrowserImagePostPhotoDimensionsReader(),
    });
  }

  async loadDraft(
    source: ImagePostSource | null,
    workflow: ImagePostDraft['workflow'] = 'photos',
  ): Promise<ImagePostDraft> {
    const id = imagePostDraftId(source?.articlePath ?? null, workflow);
    const draftSource = workflow === 'photos' ? null : source;
    return await this.drafts.load(id) ?? createImagePostDraft({ id, source: draftSource, workflow });
  }

  saveDraft(draft: ImagePostDraft): Promise<void> {
    return this.drafts.save(draft);
  }

  loadLegacyPhotoDraft(source: ImagePostSource): Promise<ImagePostDraft | null> {
    return this.drafts.load(legacyImagePostPhotoDraftId(source.articlePath));
  }

  async restoreLegacyPhotoDraft(source: ImagePostSource): Promise<ImagePostDraft> {
    const legacy = await this.loadLegacyPhotoDraft(source);
    if (!legacy) throw new Error('当前文章没有可恢复的旧图文草稿。');
    const current = await this.drafts.load(STANDALONE_PHOTO_DRAFT_ID);
    if (current) {
      await this.drafts.save(clonePhotoDraft(current, STANDALONE_PHOTO_BACKUP_ID));
    }
    const restored = clonePhotoDraft(legacy, STANDALONE_PHOTO_DRAFT_ID);
    await this.drafts.save(restored);
    return restored;
  }

  loadStandalonePhotoDraftBackup(): Promise<ImagePostDraft | null> {
    return this.drafts.load(STANDALONE_PHOTO_BACKUP_ID);
  }

  async restoreStandalonePhotoDraftBackup(): Promise<ImagePostDraft> {
    const backup = await this.loadStandalonePhotoDraftBackup();
    if (!backup) throw new Error('没有可恢复的独立照片草稿备份。');
    const restored = clonePhotoDraft(backup, STANDALONE_PHOTO_DRAFT_ID);
    await this.drafts.save(restored);
    return restored;
  }

  importPhoto(input: ImportImagePostPhotoInput) {
    return this.assets.importPhoto(input);
  }

  importPhotoBytes(input: ImportImagePostPhotoBytesInput) {
    return this.assets.importPhotoBytes(input);
  }

  async importPhotoSource(input: NormalizeImagePostPhotoInput) {
    const normalized = await this.photoNormalizer.normalize(input);
    const material = await this.assets.importPhotoBytes({
      bytes: normalized.bytes,
      originalName: normalized.originalName,
      storageFileName: normalized.storageFileName,
      width: normalized.width,
      height: normalized.height,
    });
    return {
      material,
      converted: normalized.converted,
      sourceFormat: normalized.sourceFormat,
    } as const;
  }

  importRenderedCard(input: ImportRenderedImagePostCardInput) {
    return this.assets.importRenderedCard(input);
  }

  readMaterialBytes(material: ImagePostMaterial): Promise<Uint8Array> {
    return this.assets.readMaterial(material);
  }

  async handoff(prepared: PreparedImagePost, options: ImagePostHandoffOptions = {}) {
    await Promise.all(prepared.materials.map(material => this.assets.readMaterial(material)));
    return await handoffPreparedImagePost(prepared, this.coordinator, options);
  }

  async openDestination(destination: ImagePostDestination): Promise<void> {
    if (!this.openDestinationEditor) throw new Error('专用 Chrome 打开入口不可用。');
    await this.openDestinationEditor(destination, AbortSignal.timeout(30_000));
  }
}

export function imagePostDraftId(
  articlePath: string | null,
  workflow: ImagePostDraft['workflow'] = 'photos',
): string {
  if (workflow === 'photos') return 'standalone';
  if (!articlePath) return 'cards_standalone';
  return `cards_${legacyImagePostPhotoDraftId(articlePath)}`;
}

export function legacyImagePostPhotoDraftId(articlePath: string): string {
  return `article_${createHash('sha256').update(articlePath, 'utf8').digest('hex').slice(0, 24)}`;
}

function clonePhotoDraft(draft: ImagePostDraft, id: string): ImagePostDraft {
  if (draft.workflow !== 'photos') throw new Error('只能恢复照片图文草稿。');
  const destinationCopy: ImagePostDraft['destinationCopy'] = {};
  for (const destination of ['rednote', 'wechat-image'] as const) {
    const copy = draft.destinationCopy[destination];
    if (copy) destinationCopy[destination] = { ...copy, topics: [...copy.topics] };
  }
  return {
    ...draft,
    id,
    source: null,
    revision: draft.revision + 1,
    materials: draft.materials.map(material => ({ ...material })),
    activeMaterialId: draft.activeMaterialId,
    sharedCopy: { ...draft.sharedCopy, topics: [...draft.sharedCopy.topics] },
    destinationCopy,
    selectedCardPages: [],
  };
}
