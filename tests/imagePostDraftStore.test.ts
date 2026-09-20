import { describe, expect, test } from 'vitest';

import {
  addImagePostMaterial,
  createImagePostDraft,
  ImagePostDraftStore,
  setDestinationImagePostCopy,
  type ImagePostDraftFileSystem,
} from '../src/imagePost';

class MemoryDraftFileSystem implements ImagePostDraftFileSystem {
  readonly files = new Map<string, Uint8Array>();

  async mkdir(_path: string): Promise<void> {}

  async readFileIfExists(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.slice() ?? null;
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes.slice());
  }
}

describe('image post draft persistence', () => {
  test('restores an article-free draft from metadata without embedding image bytes', async () => {
    const fileSystem = new MemoryDraftFileSystem();
    const firstSession = new ImagePostDraftStore({
      directory: '/vault/.ailu/image-posts/drafts',
      fileSystem,
    });
    let draft = createImagePostDraft({ id: 'photo-story', source: null });
    draft = addImagePostMaterial(draft, {
      id: 'photo-1',
      kind: 'photo',
      fileName: 'photo-1.jpg',
      originalName: 'IMG_0001.jpg',
      contentHash: 'e'.repeat(64),
      managedPath: '/vault/.ailu/image-posts/assets/photo-1.jpg',
      mimeType: 'image/jpeg',
      width: 1200,
      height: 1600,
    });
    draft = setDestinationImagePostCopy(draft, 'wechat-image', {
      title: '微信标题', body: '微信文案', topics: ['学习'],
    });

    await firstSession.save(draft);
    const serialized = new TextDecoder().decode([...fileSystem.files.values()][0]);
    expect(serialized).toContain('/vault/.ailu/image-posts/assets/photo-1.jpg');
    expect(serialized).toContain('e'.repeat(64));
    expect(serialized).not.toContain('base64');

    const afterRestart = new ImagePostDraftStore({
      directory: '/vault/.ailu/image-posts/drafts',
      fileSystem,
    });
    await expect(afterRestart.load('photo-story')).resolves.toEqual(draft);
    await expect(afterRestart.load('missing')).resolves.toBeNull();
  });

  test('reports damaged draft metadata instead of silently replacing it', async () => {
    const fileSystem = new MemoryDraftFileSystem();
    fileSystem.files.set(
      '/vault/.ailu/image-posts/drafts/broken.json',
      new TextEncoder().encode('{"schemaVersion":1,"draft":'),
    );
    const store = new ImagePostDraftStore({
      directory: '/vault/.ailu/image-posts/drafts',
      fileSystem,
    });

    await expect(store.load('broken')).rejects.toThrow('图文草稿“broken”损坏');
  });
});
