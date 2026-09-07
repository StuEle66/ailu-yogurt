import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { App, TFile } from 'obsidian';
import { FileSystemAdapter } from 'obsidian';
import { captureWeChatCoverTarget, saveWeChatCover, restoreWeChatBodyFirstCover } from '../src/ui/wechatCoverAttachment';
import { onePixelJpeg } from './fixtures/imageBytes';
vi.mock('obsidian', () => ({ FileSystemAdapter: class {}, TFile: class {} }));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ailu-cover-'));
  const note = { path: 'article.md', extension: 'md', basename: 'article' } as TFile;
  await writeFile(path.join(root, note.path), 'body');
  const metadata: Record<string, unknown> = { title: 'Keep title' };
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => root;
  let failure = false;
  const app = { vault: {
    adapter, getAbstractFileByPath: (p: string) => p === note.path ? note : null,
    createBinary: async (p: string, bytes: ArrayBuffer) => {
      await writeFile(path.join(root, p), new Uint8Array(bytes), { flag: 'wx' });
      return { path: p };
    },
  }, fileManager: {
    getAvailablePathForAttachment: async () => 'cover-1.jpg',
    processFrontMatter: async (_file: TFile, edit: (data: Record<string, unknown>) => void) => {
      if (failure) throw new Error('write denied');
      edit(metadata);
    },
  } } as unknown as App;
  return { root, note, app, metadata, fail: () => { failure = true; } };
}
test('saving a cover writes an independent attachment and preserves article body', async () => {
  const f = await fixture();
  try {
    const result = await saveWeChatCover(f.app, captureWeChatCoverTarget(f.app, f.note), onePixelJpeg());
    expect(result.attachmentPath).toBe('cover-1.jpg');
    expect(f.metadata).toEqual({ title: 'Keep title', wechat_cover: 'cover-1.jpg' });
    expect(await readFile(path.join(f.root, 'article.md'), 'utf8')).toBe('body');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a moved article cannot receive the pending cover', async () => {
  const f = await fixture();
  try {
    const target = captureWeChatCoverTarget(f.app, f.note);
    f.note.path = 'moved.md';
    await expect(saveWeChatCover(f.app, target, onePixelJpeg())).rejects.toThrow('原文章已移动');
    expect(f.metadata.wechat_cover).toBeUndefined();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('frontmatter failure reports the retained attachment path', async () => {
  const f = await fixture();
  try {
    f.fail();
    await expect(saveWeChatCover(f.app, captureWeChatCoverTarget(f.app, f.note), onePixelJpeg()))
      .rejects.toThrow('图片已保存到 cover-1.jpg');
    expect(await readFile(path.join(f.root, 'cover-1.jpg'))).toEqual(Buffer.from(onePixelJpeg()));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('restore removes only wechat_cover and retains its file', async () => {
  const f = await fixture();
  try {
    const target = captureWeChatCoverTarget(f.app, f.note);
    await saveWeChatCover(f.app, target, onePixelJpeg());
    await restoreWeChatBodyFirstCover(f.app, target);
    expect(f.metadata).toEqual({ title: 'Keep title' });
    expect(await readFile(path.join(f.root, 'cover-1.jpg'))).toEqual(Buffer.from(onePixelJpeg()));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a truncated JPEG is rejected before creating an attachment', async () => {
  const f = await fixture();
  try {
    await expect(saveWeChatCover(f.app, captureWeChatCoverTarget(f.app, f.note),
      Uint8Array.from([255, 216, 255, 217]).buffer)).rejects.toThrow();
    await expect(readFile(path.join(f.root, 'cover-1.jpg'))).rejects.toThrow();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('an occupied attachment destination never overwrites the old photograph', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'cover-1.jpg'), 'old photo');
    await expect(saveWeChatCover(f.app, captureWeChatCoverTarget(f.app, f.note), onePixelJpeg())).rejects.toThrow();
    expect(await readFile(path.join(f.root, 'cover-1.jpg'), 'utf8')).toBe('old photo');
    expect(f.metadata.wechat_cover).toBeUndefined();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
