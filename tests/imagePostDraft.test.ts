import { describe, expect, test } from 'vitest';

import {
  addImagePostMaterial,
  createImagePostDraft,
  moveImagePostMaterial,
  prepareImagePost,
  removeImagePostMaterial,
  resetDestinationImagePostCopy,
  resolveImagePostCopy,
  setImagePostActiveMaterial,
  setDestinationImagePostCopy,
  setImagePostLeadMaterial,
  updateSharedImagePostCopy,
  type ImagePostMaterial,
} from '../src/imagePost';
import { imagePostDraftId } from '../src/imagePost/controller';

describe('image post draft materials', () => {
  test('uses one article-independent photo draft while keeping card drafts article-bound', () => {
    expect(imagePostDraftId('Ideas/First.md', 'photos')).toBe('standalone');
    expect(imagePostDraftId('Ideas/Second.md', 'photos')).toBe('standalone');
    expect(imagePostDraftId('Ideas/First.md', 'cards')).toMatch(/^cards_article_[a-f0-9]{24}$/u);
    expect(imagePostDraftId('Ideas/First.md', 'cards'))
      .not.toBe(imagePostDraftId('Ideas/Second.md', 'cards'));
  });

  test('creates revisioned photo and card workspaces with isolated material kinds', () => {
    let photos = createImagePostDraft({ id: 'photos', source: null, workflow: 'photos' });
    expect(photos).toMatchObject({ workflow: 'photos', revision: 0 });
    photos = addImagePostMaterial(photos, {
      id: 'photo-only', kind: 'photo', fileName: 'photo.jpg', originalName: 'photo.jpg',
      contentHash: 'f'.repeat(64), width: 900, height: 1200,
      managedPath: '/managed/photo.jpg', mimeType: 'image/jpeg',
    });
    expect(photos.revision).toBe(1);
    expect(() => addImagePostMaterial(photos, {
      id: 'card-not-allowed', kind: 'card', fileName: '01.png', renderedPage: 1,
      contentHash: 'c'.repeat(64), width: 1800, height: 2400,
      managedPath: '/managed/01.png', mimeType: 'image/png',
    })).toThrow('照片草稿只能包含手动选择的照片');

    const cards = createImagePostDraft({ id: 'cards', source: null, workflow: 'cards' });
    expect(cards).toMatchObject({ workflow: 'cards', revision: 0 });
    expect(() => addImagePostMaterial(cards, photos.materials[0])).toThrow('图卡工作区只能包含渲染图卡');
  });

  test('supports an article-free ordered photo draft', () => {
    let draft = createImagePostDraft({ id: 'draft-1', source: null, workflow: 'photos' });

    draft = addImagePostMaterial(draft, {
      id: 'photo-1',
      kind: 'photo',
      fileName: 'portrait.jpg',
      contentHash: 'b'.repeat(64),
      width: 1200,
      height: 1600,
      managedPath: 'assets/photo-1.jpg',
      mimeType: 'image/jpeg',
      originalName: 'IMG_0001.jpg',
    });
    draft = addImagePostMaterial(draft, {
      id: 'photo-2', kind: 'photo', fileName: 'second.jpg', originalName: 'IMG_0002.jpg',
      contentHash: 'a'.repeat(64), width: 1200, height: 1600,
      managedPath: 'assets/photo-2.jpg', mimeType: 'image/jpeg',
    });
    draft = moveImagePostMaterial(draft, 'photo-2', 0);
    draft = setImagePostLeadMaterial(draft, 'photo-1');

    expect(draft.source).toBeNull();
    expect(draft.materials.map(material => [material.id, material.kind])).toEqual([
      ['photo-2', 'photo'],
      ['photo-1', 'photo'],
    ]);
    expect(draft.leadMaterialId).toBe('photo-1');

    const withoutPhoto = removeImagePostMaterial(draft, 'photo-2');
    expect(withoutPhoto.materials.map(material => material.id)).toEqual(['photo-1']);
    expect(draft.materials.map(material => material.id)).toEqual(['photo-2', 'photo-1']);
  });

  test('keeps the selected photo stable while editing and reordering', () => {
    let draft = createImagePostDraft({ id: 'photo-preview', source: null, workflow: 'photos' });
    for (const [index, id] of ['one', 'two', 'three'].entries()) {
      draft = addImagePostMaterial(draft, {
        id,
        kind: 'photo',
        fileName: `${id}.jpg`,
        originalName: `${id}.jpg`,
        contentHash: String(index + 1).repeat(64),
        width: 1200,
        height: 1600,
        managedPath: `/managed/${id}.jpg`,
        mimeType: 'image/jpeg',
      });
    }

    draft = setImagePostActiveMaterial(draft, 'two');
    draft = updateSharedImagePostCopy(draft, { title: '刚输入的标题', body: '', topics: [] });
    draft = moveImagePostMaterial(draft, 'two', 0);

    expect(draft.activeMaterialId).toBe('two');
    expect(draft.materials.map(material => material.id)).toEqual(['two', 'one', 'three']);
  });

  test('moves the preview to an adjacent photo when the selected photo is removed', () => {
    let draft = createImagePostDraft({ id: 'photo-remove', source: null, workflow: 'photos' });
    for (const [index, id] of ['one', 'two', 'three'].entries()) {
      draft = addImagePostMaterial(draft, {
        id,
        kind: 'photo',
        fileName: `${id}.png`,
        originalName: `${id}.png`,
        contentHash: String(index + 1).repeat(64),
        width: 1200,
        height: 1600,
        managedPath: `/managed/${id}.png`,
        mimeType: 'image/png',
      });
    }
    draft = setImagePostActiveMaterial(draft, 'two');

    draft = removeImagePostMaterial(draft, 'two');
    expect(draft.activeMaterialId).toBe('three');
    expect(() => setImagePostActiveMaterial(draft, 'missing')).toThrow('找不到图文素材');
  });

  test('shares copy by default and preserves an explicit platform override until reset', () => {
    let draft = createImagePostDraft({ id: 'draft-copy', source: null });
    draft = updateSharedImagePostCopy(draft, {
      title: '共用标题',
      body: '共用正文',
      topics: ['AI', '科研'],
    });
    draft = setDestinationImagePostCopy(draft, 'rednote', {
      title: '小红书标题',
      body: '小红书正文',
      topics: ['AI工具'],
    });
    draft = updateSharedImagePostCopy(draft, {
      title: '更新后的共用标题',
      body: '更新后的共用正文',
      topics: ['工作流'],
    });

    expect(resolveImagePostCopy(draft, 'rednote')).toEqual({
      title: '小红书标题',
      body: '小红书正文',
      topics: ['AI工具'],
    });
    expect(resolveImagePostCopy(draft, 'wechat-image')).toEqual({
      title: '更新后的共用标题',
      body: '更新后的共用正文',
      topics: ['工作流'],
    });

    draft = resetDestinationImagePostCopy(draft, 'rednote');
    expect(resolveImagePostCopy(draft, 'rednote')).toEqual(resolveImagePostCopy(draft, 'wechat-image'));
  });

  test('deep-freezes a content-addressed send snapshot against later draft edits', () => {
    let draft = createImagePostDraft({
      id: 'draft-frozen',
      source: { articlePath: 'Ideas/Post.md', contentVersion: 'editor-v7' },
      workflow: 'cards',
    });
    draft = addImagePostMaterial(draft, {
      id: 'card-frozen',
      kind: 'card',
      fileName: '01.png',
      contentHash: 'c'.repeat(64),
      width: 1800,
      height: 2400,
      managedPath: '/vault/.ailu/image-posts/cards/01.png',
      mimeType: 'image/png',
      renderedPage: 1,
    });
    draft = updateSharedImagePostCopy(draft, {
      title: '发送标题',
      body: '发送正文',
      topics: ['Obsidian'],
    });

    const prepared = prepareImagePost(draft, ['rednote', 'wechat-image']);
    draft.sharedCopy.title = '之后修改';
    draft.sharedCopy.topics.push('之后的话题');
    draft.materials[0].fileName = 'changed.png';

    expect(prepared).toMatchObject({
      schemaVersion: 1,
      draftId: 'draft-frozen',
      workflow: 'cards',
      source: { articlePath: 'Ideas/Post.md', contentVersion: 'editor-v7' },
      leadMaterialId: 'card-frozen',
      destinations: ['rednote', 'wechat-image'],
      materials: [{ fileName: '01.png' }],
      copyByDestination: {
        rednote: { title: '发送标题', topics: ['Obsidian'] },
        'wechat-image': { title: '发送标题', topics: ['Obsidian'] },
      },
    });
    expect(prepared.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.materials)).toBe(true);
    expect(Object.isFrozen(prepared.materials[0])).toBe(true);
    expect(Object.isFrozen(prepared.copyByDestination.rednote!.topics)).toBe(true);
    expect(() => {
      (prepared.materials as ImagePostMaterial[])[0].fileName = 'mutated.png';
    }).toThrow(TypeError);

    const changedDraft = updateSharedImagePostCopy(draft, {
      title: '不同版本', body: '发送正文', topics: ['Obsidian'],
    });
    expect(prepareImagePost(changedDraft, ['rednote', 'wechat-image']).contentHash)
      .not.toBe(prepared.contentHash);
  });
});
