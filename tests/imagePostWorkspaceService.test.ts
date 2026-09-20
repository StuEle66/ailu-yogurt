import { describe, expect, it } from 'vitest';

import {
  createImagePostDraft,
  prepareImagePost,
  setDestinationImagePostCopy,
  updateSharedImagePostCopy,
} from '../src/imagePost';
import { handoffPreparedImagePost } from '../src/imagePost/workspaceService';

describe('image post workspace service', () => {
  it('starts WeChat without waiting for a stalled Xiaohongshu handoff', async () => {
    const draft = createImagePostDraft({ id: 'draft_parallel', source: null });
    draft.materials = [
      { id: 'a', kind: 'photo', fileName: 'a.png', originalName: 'a.png', contentHash: 'a'.repeat(64), width: 900, height: 1200, managedPath: '/managed/a.png', mimeType: 'image/png' },
    ];
    draft.leadMaterialId = 'a';
    const prepared = prepareImagePost(draft, ['rednote', 'wechat-image']);
    const calls: string[] = [];
    let releaseRedNote!: () => void;
    const redNoteGate = new Promise<void>(resolve => { releaseRedNote = resolve; });
    const coordinator = {
      async handoff(_input: unknown, destinations: readonly string[]) {
        const destination = destinations[0];
        calls.push(destination);
        if (destination === 'rednote') await redNoteGate;
        return { preparedId: prepared.contentHash, outcomes: {} };
      },
    };

    const operation = handoffPreparedImagePost(prepared, coordinator);
    try {
      await Promise.resolve();
      expect(calls).toEqual(['rednote', 'wechat-image']);
    } finally {
      releaseRedNote();
      await operation;
    }
  });

  it('returns the WeChat outcome when Xiaohongshu fails independently', async () => {
    const draft = createImagePostDraft({ id: 'draft_partial', source: null });
    draft.materials = [
      { id: 'a', kind: 'photo', fileName: 'a.png', originalName: 'a.png', contentHash: 'a'.repeat(64), width: 900, height: 1200, managedPath: '/managed/a.png', mimeType: 'image/png' },
    ];
    draft.leadMaterialId = 'a';
    const prepared = prepareImagePost(draft, ['rednote', 'wechat-image']);
    const coordinator = {
      async handoff(_input: unknown, destinations: readonly string[]) {
        if (destinations[0] === 'rednote') throw new Error('小红书窗口失联');
        return {
          preparedId: prepared.contentHash,
          outcomes: {
            'wechat-image': {
              destination: 'wechat-image' as const,
              status: 'editor-filled' as const,
              reason: null,
              message: '微信完成',
            },
          },
        };
      },
    };

    await expect(handoffPreparedImagePost(prepared, coordinator)).resolves.toMatchObject({
      rednote: { outcomes: { rednote: { status: 'failed' } } },
      'wechat-image': { outcomes: { 'wechat-image': { status: 'editor-filled' } } },
    });
  });

  it('maps each destination copy and the frozen material order to its adapter', async () => {
    let draft = createImagePostDraft({
      id: 'draft_1',
      source: { articlePath: 'notes/a.md', contentVersion: 'version-1' },
    });
    draft.materials = [
      { id: 'a', kind: 'photo', fileName: 'a.png', originalName: 'a.png', contentHash: 'a'.repeat(64), width: 900, height: 1200, managedPath: '/managed/a.png', mimeType: 'image/png' },
      { id: 'b', kind: 'card', fileName: 'b.png', renderedPage: 1, contentHash: 'b'.repeat(64), width: 1800, height: 2400, managedPath: '/managed/b.png', mimeType: 'image/png' },
    ];
    draft.leadMaterialId = 'a';
    draft = updateSharedImagePostCopy(draft, { title: '共用标题', body: '共用正文', topics: ['共用'] });
    draft = setDestinationImagePostCopy(draft, 'rednote', { title: '小红书标题', body: '小红书正文', topics: ['红书'] });
    const prepared = prepareImagePost(draft, ['rednote', 'wechat-image']);
    const calls: Array<{ title: string; paths: string[]; destination: string }> = [];
    const coordinator = {
      async handoff(input: { title: string; images: readonly { path: string }[] }, destinations: readonly string[]) {
        calls.push({ title: input.title, paths: input.images.map(image => image.path), destination: destinations[0] });
        return { preparedId: prepared.contentHash, outcomes: {} };
      },
    };

    await handoffPreparedImagePost(prepared, coordinator);

    expect(calls).toEqual([
      { title: '小红书标题', paths: ['/managed/a.png', '/managed/b.png'], destination: 'rednote' },
      { title: '共用标题', paths: ['/managed/a.png', '/managed/b.png'], destination: 'wechat-image' },
    ]);
  });
});
