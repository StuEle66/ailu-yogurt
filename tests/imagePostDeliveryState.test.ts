import { describe, expect, test } from 'vitest';

import {
  addImagePostMaterial,
  createImagePostDeliveryState,
  createImagePostDraft,
  prepareImagePost,
  retryFailedImagePostDestinations,
  settleImagePostDestination,
  startImagePostDestination,
} from '../src/imagePost';

function preparedPost() {
  let draft = createImagePostDraft({ id: 'delivery', source: null });
  draft = addImagePostMaterial(draft, {
    id: 'photo',
    kind: 'photo',
    fileName: 'photo.jpg',
    originalName: 'photo.jpg',
    contentHash: 'd'.repeat(64),
    managedPath: '/vault/.ailu/image-posts/photo.jpg',
    mimeType: 'image/jpeg',
    width: 1200,
    height: 1600,
  });
  return prepareImagePost(draft, ['rednote', 'wechat-image']);
}

describe('image post destination state', () => {
  test('keeps partial success and retries only the explicitly failed destination', () => {
    let state = createImagePostDeliveryState(preparedPost());
    state = startImagePostDestination(state, 'rednote', '正在上传小红书');
    state = startImagePostDestination(state, 'wechat-image', '正在上传微信贴图');
    state = settleImagePostDestination(state, 'rednote', {
      status: 'succeeded',
      message: '已填入后台，等待检查',
      reviewUrl: 'https://creator.xiaohongshu.com/editor/1',
    });
    state = settleImagePostDestination(state, 'wechat-image', {
      status: 'failed',
      message: '登录已过期',
    });

    const retry = retryFailedImagePostDestinations(state);
    expect(retry.destinations).toEqual(['wechat-image']);
    expect(retry.state.destinations.rednote).toMatchObject({
      status: 'succeeded',
      reviewUrl: 'https://creator.xiaohongshu.com/editor/1',
    });
    expect(retry.state.destinations['wechat-image']).toEqual({
      status: 'pending', message: '', reviewUrl: null,
    });
  });

  test('does not blindly retry a destination whose remote result is uncertain', () => {
    let state = createImagePostDeliveryState(preparedPost());
    state = startImagePostDestination(state, 'rednote');
    state = settleImagePostDestination(state, 'rednote', {
      status: 'uncertain',
      message: '页面中断，请先检查已有编辑器',
    });

    const retry = retryFailedImagePostDestinations(state);
    expect(retry.destinations).toEqual([]);
    expect(retry.state.destinations.rednote?.status).toBe('uncertain');
  });
});
