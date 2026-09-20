import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createImagePostDraft,
  ImagePostDraftStore,
  ManagedImagePostAssetStore,
  type ImagePostDraft,
  type ImagePostSource,
  type ImportImagePostPhotoInput,
  type ImportRenderedImagePostCardInput,
  type PreparedImagePost,
} from './index';
import { handoffPreparedImagePost, type ImagePostHandoffCoordinatorLike } from './workspaceService';

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

  async loadDraft(source: ImagePostSource | null): Promise<ImagePostDraft> {
    const id = imagePostDraftId(source?.articlePath ?? null);
    return await this.drafts.load(id) ?? createImagePostDraft({ id, source });
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

  handoff(prepared: PreparedImagePost) {
    return handoffPreparedImagePost(prepared, this.coordinator);
  }
}

export function imagePostDraftId(articlePath: string | null): string {
  if (!articlePath) return 'standalone';
  return `article_${createHash('sha256').update(articlePath, 'utf8').digest('hex').slice(0, 24)}`;
}
