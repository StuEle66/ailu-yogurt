import path from 'node:path';
import type { App, TFile } from 'obsidian';
import { ImagePreflight } from '../publishing/imagePreflight';
import { readVerifiedVaultFile, verifyVaultNewFileTarget } from '../utils/vault';

export interface WeChatCoverTarget { readonly file: TFile; readonly path: string }
export interface WeChatCoverSaveResult { attachmentPath: string; notePath: string }
export function captureWeChatCoverTarget(app: App, file: TFile): WeChatCoverTarget {
  const target = Object.freeze({ file, path: file.path });
  assertTarget(app, target);
  return target;
}
function assertTarget(app: App, target: WeChatCoverTarget): void {
  if (target.file.extension !== 'md' || target.file.path !== target.path
    || app.vault.getAbstractFileByPath(target.path) !== target.file) {
    throw new Error('原文章已移动、删除或替换，请回到文章重新选择封面。');
  }
}
export async function saveWeChatCover(app: App, target: WeChatCoverTarget, jpeg: ArrayBuffer): Promise<WeChatCoverSaveResult> {
  assertTarget(app, target);
  const bytes = new Uint8Array(jpeg);
  if (bytes.length < 4 || bytes.length > 10 * 1024 * 1024 || bytes[0] !== 255 || bytes[1] !== 216
    || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) {
    throw new Error('封面 JPEG 数据无效或超过 10 MB。');
  }
  await new ImagePreflight().prepareCover({ id: 'selected-cover', fileName: 'wechat-cover.jpg', mimeType: 'image/jpeg', body: jpeg, references: [] });
  await readVerifiedVaultFile(app, target.file, 10 * 1024 * 1024, true);
  const attachmentPath = await app.fileManager.getAvailablePathForAttachment('wechat-cover.jpg', target.path);
  assertTarget(app, target);
  await verifyVaultNewFileTarget(app, attachmentPath);
  assertTarget(app, target);
  const attachment = await app.vault.createBinary(attachmentPath, jpeg);
  try {
    assertTarget(app, target);
    await app.fileManager.processFrontMatter(target.file, frontmatter => {
      assertTarget(app, target);
      (frontmatter as Record<string, unknown>).wechat_cover = path.posix.relative(path.posix.dirname(target.path), attachment.path);
    });
  } catch (error) {
    throw new Error(`图片已保存到 ${attachment.path}，但封面属性写入失败：${error instanceof Error ? error.message : '请重试。'}`);
  }
  return { attachmentPath: attachment.path, notePath: target.path };
}
export async function restoreWeChatBodyFirstCover(app: App, target: WeChatCoverTarget): Promise<void> {
  assertTarget(app, target);
  await readVerifiedVaultFile(app, target.file, 10 * 1024 * 1024, true);
  assertTarget(app, target);
  await app.fileManager.processFrontMatter(target.file, frontmatter => {
    assertTarget(app, target);
    delete (frontmatter as Record<string, unknown>).wechat_cover;
  });
}
