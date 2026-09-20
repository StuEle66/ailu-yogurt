import { BrowserImagePostDestinationAdapter } from './browserAdapter';
import type { ImagePostBrowserDriver, ImagePostDestinationAdapter } from './types';

export function createXiaohongshuImagePostAdapter(
  driver: ImagePostBrowserDriver,
): ImagePostDestinationAdapter {
  return new BrowserImagePostDestinationAdapter('rednote', driver);
}

export function createWechatImagePostAdapter(
  driver: ImagePostBrowserDriver,
): ImagePostDestinationAdapter {
  return new BrowserImagePostDestinationAdapter('wechat-image', driver);
}
