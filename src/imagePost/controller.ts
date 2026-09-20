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
  type ImportImagePostPhotoInput,
  type ImportRenderedImagePostCardInput,
  type PreparedImagePost,
} from './index';
import {
  handoffPreparedImagePost,
  type ImagePostHandoffCoordinatorLike,
  type ImagePostHandoffOptions,
} from './workspaceService';

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

export class ImagePostWorkspaceController {
  private readonly drafts: ImagePostDraftStore;
  private readonly assets: ManagedImagePostAssetStore;

  constructor(
    rootDirectory: string,
    private readonly coordinator: ImagePostHandoffCoordinatorLike,
    private readonly openDestinationEditor?: (
      destination: ImagePostDestination,
      signal: AbortSignal,
    ) => Promise<void>,
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
  }

  async loadDraft(
    source: ImagePostSource | null,
    workflow: ImagePostDraft['workflow'] = 'photos',
  ): Promise<ImagePostDraft> {
    const baseId = imagePostDraftId(source?.articlePath ?? null);
    const id = workflow === 'cards' ? `cards_${baseId}` : baseId;
    return await this.drafts.load(id) ?? createImagePostDraft({ id, source, workflow });
  }

  saveDraft(draft: ImagePostDraft): Promise<void> {
    return this.drafts.save(draft);
  }

  importPhoto(input: ImportImagePostPhotoInput) {
    return this.assets.importPhoto(input);
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

export function imagePostDraftId(articlePath: string | null): string {
  if (!articlePath) return 'standalone';
  return `article_${createHash('sha256').update(articlePath, 'utf8').digest('hex').slice(0, 24)}`;
}
