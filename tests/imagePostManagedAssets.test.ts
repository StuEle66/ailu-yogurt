import { describe, expect, test } from 'vitest';

import {
  ManagedImagePostAssetStore,
  type ManagedAssetFileSystem,
} from '../src/imagePost';

class MemoryFileSystem implements ManagedAssetFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly directories: string[] = [];

  async mkdir(path: string): Promise<void> {
    this.directories.push(path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`missing: ${path}`);
    return bytes.slice();
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    if (this.files.has(path)) throw new Error(`exists: ${path}`);
    this.files.set(path, bytes.slice());
  }
}

describe('managed image post assets', () => {
  test('copies same-named photos into distinct managed paths without changing their sources', async () => {
    const fileSystem = new MemoryFileSystem();
    const firstBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x01]);
    const secondBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x02]);
    fileSystem.files.set('/photos/day-one/IMG_0001.jpg', firstBytes);
    fileSystem.files.set('/photos/day-two/IMG_0001.jpg', secondBytes);
    const ids = ['photo-a', 'photo-b'];
    const store = new ManagedImagePostAssetStore({
      rootDirectory: '/vault/.ailu/image-posts/assets',
      fileSystem,
      createId: () => ids.shift()!,
    });

    const first = await store.importPhoto({
      sourcePath: '/photos/day-one/IMG_0001.jpg',
      originalName: 'IMG_0001.jpg',
      width: 1200,
      height: 1600,
    });
    const second = await store.importPhoto({
      sourcePath: '/photos/day-two/IMG_0001.jpg',
      originalName: 'IMG_0001.jpg',
      width: 1800,
      height: 1200,
    });

    expect(first.managedPath).not.toBe(second.managedPath);
    expect(first).toMatchObject({ id: 'photo-a', kind: 'photo', originalName: 'IMG_0001.jpg' });
    expect(second).toMatchObject({ id: 'photo-b', kind: 'photo', originalName: 'IMG_0001.jpg' });
    expect(fileSystem.files.get(first.managedPath)).toEqual(firstBytes);
    expect(fileSystem.files.get(second.managedPath)).toEqual(secondBytes);
    expect(fileSystem.files.get('/photos/day-one/IMG_0001.jpg')).toEqual(firstBytes);
    expect(fileSystem.files.get('/photos/day-two/IMG_0001.jpg')).toEqual(secondBytes);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('materializes a rendered PNG card into the same managed asset boundary', async () => {
    const fileSystem = new MemoryFileSystem();
    const store = new ManagedImagePostAssetStore({
      rootDirectory: '/vault/.ailu/image-posts/assets',
      fileSystem,
      createId: () => 'card-a',
    });
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);

    const card = await store.importRenderedCard({
      bytes,
      fileName: '文章-01.png',
      page: 1,
      width: 1800,
      height: 2400,
    });

    expect(card).toMatchObject({
      id: 'card-a',
      kind: 'card',
      fileName: '文章-01.png',
      renderedPage: 1,
      width: 1800,
      height: 2400,
      mimeType: 'image/png',
    });
    expect(fileSystem.files.get(card.managedPath)).toEqual(bytes);
    expect(card.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('rejects unsupported HEIC and damaged image bytes without creating a managed copy', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set('/photos/raw.HEIC', Uint8Array.from([0, 1, 2]));
    fileSystem.files.set('/photos/fake.jpg', Uint8Array.from([0, 1, 2]));
    const store = new ManagedImagePostAssetStore({
      rootDirectory: '/vault/.ailu/image-posts/assets',
      fileSystem,
      createId: () => 'unused',
    });

    await expect(store.importPhoto({
      sourcePath: '/photos/raw.HEIC',
      originalName: 'raw.HEIC',
      width: 1200,
      height: 1600,
    })).rejects.toThrow('HEIC 请先导出为 JPEG');
    await expect(store.importPhoto({
      sourcePath: '/photos/fake.jpg',
      originalName: 'fake.jpg',
      width: 1200,
      height: 1600,
    })).rejects.toThrow('图片内容与文件格式不一致');
    expect([...fileSystem.files.keys()].filter(path => path.includes('/assets/'))).toEqual([]);
  });
});
