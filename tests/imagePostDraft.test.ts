import { describe, expect, test } from 'vitest';

import {
  addImagePostMaterial,
  createImagePostDraft,
  moveImagePostMaterial,
  prepareImagePost,
  removeImagePostMaterial,
  resetDestinationImagePostCopy,
  resolveImagePostCopy,
  setDestinationImagePostCopy,
  setImagePostLeadMaterial,
  updateSharedImagePostCopy,
  type ImagePostMaterial,
} from '../src/imagePost';

describe('image post draft materials', () => {
  test('supports an article-free ordered mix of rendered cards and managed photos', () => {
    let draft = createImagePostDraft({ id: 'draft-1', source: null });

    draft = addImagePostMaterial(draft, {
      id: 'card-1',
      kind: 'card',
      fileName: '01.png',
      contentHash: 'a'.repeat(64),
      width: 1800,
      height: 2400,
      managedPath: 'cards/01.png',
      mimeType: 'image/png',
      renderedPage: 1,
    });
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
    draft = moveImagePostMaterial(draft, 'photo-1', 0);
    draft = setImagePostLeadMaterial(draft, 'card-1');

    expect(draft.source).toBeNull();
    expect(draft.materials.map(material => [material.id, material.kind])).toEqual([
      ['photo-1', 'photo'],
      ['card-1', 'card'],
    ]);
    expect(draft.leadMaterialId).toBe('card-1');

    const withoutPhoto = removeImagePostMaterial(draft, 'photo-1');
    expect(withoutPhoto.materials.map(material => material.id)).toEqual(['card-1']);
    expect(draft.materials.map(material => material.id)).toEqual(['photo-1', 'card-1']);
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
