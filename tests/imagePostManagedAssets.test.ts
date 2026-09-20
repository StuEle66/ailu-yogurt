import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  ManagedImagePostAssetStore,
  ManagedImagePostPreviewStore,
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
  test('reads a validated managed material as bytes for preview and upload', async () => {
    const fileSystem = new MemoryFileSystem();
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);
    const managedPath = '/vault/.ailu/image-posts/assets/photo-a.png';
    fileSystem.files.set(managedPath, bytes);
    const store = new ManagedImagePostAssetStore({
      rootDirectory: '/vault/.ailu/image-posts/assets',
      fileSystem,
      createId: () => 'unused',
    });

    await expect(store.readMaterial({
      id: 'photo-a',
      kind: 'photo',
      fileName: 'photo-a.png',
      originalName: '旅行照片.png',
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      width: 1200,
      height: 1600,
      managedPath,
      mimeType: 'image/png',
    })).resolves.toEqual(bytes);
  });

  test('reports missing managed material without exposing a broken file URL', async () => {
    const fileSystem = new MemoryFileSystem();
    const store = new ManagedImagePostAssetStore({
      rootDirectory: '/vault/.ailu/image-posts/assets',
      fileSystem,
      createId: () => 'unused',
    });

    await expect(store.readMaterial({
      id: 'missing',
      kind: 'photo',
      fileName: 'missing.png',
      originalName: '找不到.png',
      contentHash: 'a'.repeat(64),
      width: 1200,
      height: 1600,
      managedPath: '/vault/.ailu/image-posts/assets/missing.png',
      mimeType: 'image/png',
    })).rejects.toThrow('文件不存在');
  });

  test('rejects paths outside the managed directory before reading them', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set('/private/secret.png', Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    const store = new ManagedImagePostAssetStore({
      rootDirectory: '/vault/.ailu/image-posts/assets',
      fileSystem,
      createId: () => 'unused',
    });

    await expect(store.readMaterial({
      id: 'escaped',
      kind: 'photo',
      fileName: 'secret.png',
      originalName: 'secret.png',
      contentHash: 'a'.repeat(64),
      width: 1200,
      height: 1600,
      managedPath: '/private/secret.png',
      mimeType: 'image/png',
    })).rejects.toThrow('不在 Ailu 受管目录内');
  });

  test('rejects hash mismatches and disguised image formats', async () => {
    const fileSystem = new MemoryFileSystem();
    const pngBytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);
    const managedPath = '/vault/.ailu/image-posts/assets/photo-a.png';
    fileSystem.files.set(managedPath, pngBytes);
    const store = new ManagedImagePostAssetStore({
      rootDirectory: '/vault/.ailu/image-posts/assets',
      fileSystem,
      createId: () => 'unused',
    });
    const base = {
      id: 'photo-a',
      kind: 'photo' as const,
      fileName: 'photo-a.png',
      originalName: '照片.png',
      width: 1200,
      height: 1600,
      managedPath,
      mimeType: 'image/png' as const,
    };

    await expect(store.readMaterial({ ...base, contentHash: 'b'.repeat(64) }))
      .rejects.toThrow('内容已变化');
    await expect(store.readMaterial({
      ...base,
      contentHash: createHash('sha256').update(pngBytes).digest('hex'),
      mimeType: 'image/jpeg',
    })).rejects.toThrow('图片内容与文件格式不一致');
  });

  test('caches blob previews by material hash and revokes them when no longer used', async () => {
    const revoked: string[] = [];
    let sequence = 0;
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const material = {
      id: 'photo-a',
      kind: 'photo' as const,
      fileName: 'photo-a.png',
      originalName: '照片.png',
      contentHash: 'a'.repeat(64),
      width: 1200,
      height: 1600,
      managedPath: '/vault/.ailu/image-posts/assets/photo-a.png',
      mimeType: 'image/png' as const,
    };
    const previews = new ManagedImagePostPreviewStore({
      readMaterial: async () => bytes,
      createUrl: () => `blob:managed-${++sequence}`,
      revokeUrl: url => revoked.push(url),
    });

    await expect(previews.load(material)).resolves.toBe('blob:managed-1');
    await expect(previews.load(material)).resolves.toBe('blob:managed-1');
    await expect(previews.load({ ...material, contentHash: 'b'.repeat(64) }))
      .resolves.toBe('blob:managed-2');
    expect(revoked).toEqual(['blob:managed-1']);

    previews.retain([]);
    expect(revoked).toEqual(['blob:managed-1', 'blob:managed-2']);
  });

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

  test('imports readable photo bytes without requiring a local file path', async () => {
    const fileSystem = new MemoryFileSystem();
    const store = new ManagedImagePostAssetStore({
      rootDirectory: '/vault/.ailu/image-posts/assets',
      fileSystem,
      createId: () => 'photo-from-file',
    });
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);

    const material = await store.importPhotoBytes({
      bytes,
      originalName: '照片 App 拖入.png',
      width: 1170,
      height: 1560,
    });

    expect(material).toMatchObject({
      id: 'photo-from-file',
      kind: 'photo',
      originalName: '照片 App 拖入.png',
      width: 1170,
      height: 1560,
      mimeType: 'image/png',
    });
    expect(fileSystem.files.get(material.managedPath)).toEqual(bytes);
  });

  test('rejects unsupported or damaged in-memory photos without writing a managed copy', async () => {
    const fileSystem = new MemoryFileSystem();
    const store = new ManagedImagePostAssetStore({
      rootDirectory: '/vault/.ailu/image-posts/assets',
      fileSystem,
      createId: () => 'unused',
    });

    await expect(store.importPhotoBytes({
      bytes: Uint8Array.from([0, 1, 2]),
      originalName: '照片.HEIC',
      width: 1200,
      height: 1600,
    })).rejects.toThrow('HEIC 请先导出为 JPEG');
    await expect(store.importPhotoBytes({
      bytes: Uint8Array.from([0, 1, 2]),
      originalName: '损坏.png',
      width: 1200,
      height: 1600,
    })).rejects.toThrow('图片内容与文件格式不一致');
    expect(fileSystem.files.size).toBe(0);
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
