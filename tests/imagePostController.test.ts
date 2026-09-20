import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('image post workspace controller', () => {
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
