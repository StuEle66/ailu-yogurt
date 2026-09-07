import { coverCrop } from '../src/ui/wechatCoverCrop';

describe('cover crop framing', () => {
  test('a portrait photo fills the wide cover without blank space', () => {
    expect(coverCrop(1800, 2400)).toEqual({ x: 0, y: 817, width: 1800, height: 766 });
  });
  test('wide photos and zoom retain a bounded crop even when dragged past the edge', () => {
    const left = coverCrop(3600, 766, 2, -10, 20);
    expect(left).toEqual({ x: 0, y: 383, width: 900, height: 383 });
    expect(coverCrop(1800, 2400, 1, 0.5, 0.5)).toEqual({ x: 0, y: 817, width: 1800, height: 766 });
  });
  test('invalid dimensions cannot create a crop', () => {
    expect(() => coverCrop(0, 100)).toThrow('图片尺寸无效');
  });
});
