import { describe, expect, it } from 'vitest';

import {
  createImagePostDraft,
  prepareImagePost,
  setDestinationImagePostCopy,
  updateSharedImagePostCopy,
} from '../src/imagePost';
import { handoffPreparedImagePost } from '../src/imagePost/workspaceService';

describe('image post workspace service', () => {
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
