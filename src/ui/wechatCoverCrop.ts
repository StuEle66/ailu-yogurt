export const COVER_WIDTH = 1800;
export const COVER_HEIGHT = 766;
export interface CoverCrop { x: number; y: number; width: number; height: number }
export function coverCrop(width: number, height: number, zoom = 1, x = 0.5, y = 0.5): CoverCrop {
  if (![width, height, zoom, x, y].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸无效。');
  }
  const scale = Math.max(1, Math.min(5, zoom));
  const cropWidth = Math.min(width, height * COVER_WIDTH / COVER_HEIGHT) / scale;
  const cropHeight = cropWidth * COVER_HEIGHT / COVER_WIDTH;
  return {
    x: Math.max(0, Math.min(1, x)) * (width - cropWidth),
    y: Math.max(0, Math.min(1, y)) * (height - cropHeight),
    width: cropWidth,
    height: cropHeight,
  };
}
