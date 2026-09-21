import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createImagePostDraft,
  ImagePostDraftStore,
  updateSharedImagePostCopy,
  type ImagePostDraftFileSystem,
} from '../src/imagePost';
import {
  ImagePostWorkspaceController,
  legacyImagePostPhotoDraftId,
} from '../src/imagePost/controller';
import { ImagePostPhotoNormalizer } from '../src/imagePost/photoImport';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('image post workspace controller', () => {
  test('imports a Photos DNG as a managed JPEG without storing the RAW bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ailu-photo-import-'));
    temporaryDirectories.push(root);
    const dngBytes = Uint8Array.from([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00,
      0x12, 0xc6, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
    const normalizer = new ImagePostPhotoNormalizer({
      transcoder: { convertToJpeg: async () => jpegBytes },
      dimensions: { readDimensions: async () => ({ width: 3072, height: 4096 }) },
    });
    const controller = new ImagePostWorkspaceController(root, {
      handoff: async () => { throw new Error('not used'); },
    }, undefined, normalizer);

    const imported = await controller.importPhotoSource({
      bytes: dngBytes,
      originalName: 'IMG_7715.dng',
    });

    expect(imported.converted).toBe(true);
    expect(imported.material).toMatchObject({
      kind: 'photo',
      originalName: 'IMG_7715.dng',
      mimeType: 'image/jpeg',
      width: 3072,
      height: 4096,
    });
    expect(imported.material.fileName).toMatch(/\.jpg$/u);
    const managedBytes = await controller.readMaterialBytes(imported.material);
    expect([...managedBytes]).toEqual([...jpegBytes]);
    expect(await readdir(path.join(root, 'assets'))).toHaveLength(1);
  });

  test('restores an article draft without deleting it and keeps the prior standalone draft recoverable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ailu-photo-draft-'));
    temporaryDirectories.push(root);
    const drafts = new ImagePostDraftStore({
      directory: path.join(root, 'drafts'),
      fileSystem: nodeFileSystem,
    });
    let current = createImagePostDraft({ id: 'standalone', source: null, workflow: 'photos' });
    current = updateSharedImagePostCopy(current, {
      title: '当前独立草稿', body: '恢复后仍能找回', topics: ['当前'],
    });
    const source = { articlePath: 'Ideas/Old.md', contentVersion: 'v1' };
    let legacy = createImagePostDraft({
      id: legacyImagePostPhotoDraftId(source.articlePath), source, workflow: 'photos',
    });
    legacy = updateSharedImagePostCopy(legacy, {
      title: '旧文章草稿', body: '复制到独立工作区', topics: ['旧稿'],
    });
    await drafts.save(current);
    await drafts.save(legacy);
    const controller = new ImagePostWorkspaceController(root, {
      handoff: async () => { throw new Error('not used'); },
    });

    const restored = await controller.restoreLegacyPhotoDraft(source);

    expect(restored).toMatchObject({
      id: 'standalone', source: null, sharedCopy: { title: '旧文章草稿' },
    });
    await expect(controller.loadStandalonePhotoDraftBackup()).resolves.toMatchObject({
      id: 'standalone_before_legacy_restore',
      sharedCopy: { title: '当前独立草稿' },
    });
    await expect(drafts.load(legacy.id)).resolves.toEqual(legacy);
  });
});

const nodeFileSystem: ImagePostDraftFileSystem = {
  mkdir: async directory => { await mkdir(directory, { recursive: true }); },
  readFileIfExists: async filePath => {
    try { return await readFile(filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  writeFile: async (filePath, bytes) => { await writeFile(filePath, bytes); },
};
