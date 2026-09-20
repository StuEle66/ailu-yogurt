import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  ImagePostCardMaterial,
  ImagePostMaterial,
  ImagePostPhotoMaterial,
} from './index';

export interface ManagedAssetFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
}

export interface ImportImagePostPhotoInput {
  sourcePath: string;
  originalName: string;
  width: number;
  height: number;
}

export interface ImportImagePostPhotoBytesInput {
  bytes: Uint8Array;
  originalName: string;
  width: number;
  height: number;
}

export interface ImportRenderedImagePostCardInput {
  bytes: Uint8Array;
  fileName: string;
  page: number;
  width: number;
  height: number;
}

export class ManagedImagePostAssetStore {
  private readonly rootDirectory: string;
  private readonly fileSystem: ManagedAssetFileSystem;
  private readonly createId: () => string;

  constructor(options: {
    rootDirectory: string;
    fileSystem: ManagedAssetFileSystem;
    createId: () => string;
  }) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.fileSystem = options.fileSystem;
    this.createId = options.createId;
  }

  async importPhoto(input: ImportImagePostPhotoInput): Promise<ImagePostPhotoMaterial> {
    const bytes = await this.fileSystem.readFile(input.sourcePath);
    return await this.importPhotoBytes({ ...input, bytes });
  }

  async importPhotoBytes(input: ImportImagePostPhotoBytesInput): Promise<ImagePostPhotoMaterial> {
    const format = photoFormat(input.originalName);
    assertPhotoSignature(input.bytes, format.mimeType);
    if (!Number.isFinite(input.width) || input.width <= 0
      || !Number.isFinite(input.height) || input.height <= 0) {
      throw new Error('图片尺寸无效，未导入图文素材。');
    }
    const id = this.createId();
    if (!/^[a-zA-Z0-9_-]+$/u.test(id)) {
      throw new Error('受管图片 ID 格式无效。');
    }
    const contentHash = createHash('sha256').update(input.bytes).digest('hex');
    const fileName = `${id}-${contentHash.slice(0, 12)}${format.extension}`;
    const managedPath = path.join(this.rootDirectory, fileName);
    await this.fileSystem.mkdir(this.rootDirectory);
    await this.fileSystem.writeFile(managedPath, input.bytes);
    return {
      id,
      kind: 'photo',
      fileName,
      originalName: path.basename(input.originalName),
      contentHash,
      width: input.width,
      height: input.height,
      managedPath,
      mimeType: format.mimeType,
    };
  }

  async importRenderedCard(
    input: ImportRenderedImagePostCardInput,
  ): Promise<ImagePostCardMaterial> {
    assertPhotoSignature(input.bytes, 'image/png');
    if (!Number.isInteger(input.page) || input.page <= 0) {
      throw new Error('图卡页码无效。');
    }
    if (!Number.isFinite(input.width) || input.width <= 0
      || !Number.isFinite(input.height) || input.height <= 0) {
      throw new Error('图卡尺寸无效。');
    }
    const id = this.createId();
    if (!/^[a-zA-Z0-9_-]+$/u.test(id)) {
      throw new Error('受管图片 ID 格式无效。');
    }
    const contentHash = createHash('sha256').update(input.bytes).digest('hex');
    const managedPath = path.join(
      this.rootDirectory,
      `${id}-${contentHash.slice(0, 12)}.png`,
    );
    await this.fileSystem.mkdir(this.rootDirectory);
    await this.fileSystem.writeFile(managedPath, input.bytes);
    return {
      id,
      kind: 'card',
      fileName: path.basename(input.fileName),
      contentHash,
      width: input.width,
      height: input.height,
      managedPath,
      mimeType: 'image/png',
      renderedPage: input.page,
    };
  }

  async readMaterial(material: ImagePostMaterial): Promise<Uint8Array> {
    const managedPath = this.resolveManagedPath(material.managedPath);
    let bytes: Uint8Array;
    try {
      bytes = await this.fileSystem.readFile(managedPath);
    } catch {
      throw new Error(`图文素材“${material.fileName}”文件不存在或无法读取，请移除后重新选择。`);
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    if (contentHash !== material.contentHash) {
      throw new Error(`图文素材“${material.fileName}”内容已变化，请移除后重新选择。`);
    }
    assertPhotoSignature(bytes, material.mimeType);
    return bytes.slice();
  }

  private resolveManagedPath(materialPath: string): string {
    const managedPath = path.resolve(materialPath);
    if (path.dirname(managedPath) !== this.rootDirectory) {
      throw new Error('图文素材不在 Ailu 受管目录内，已拒绝读取。');
    }
    return managedPath;
  }
}

function photoFormat(originalName: string): {
  extension: '.jpg' | '.jpeg' | '.png' | '.webp';
  mimeType: ImagePostPhotoMaterial['mimeType'];
} {
  const extension = path.extname(originalName).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') {
    return { extension, mimeType: 'image/jpeg' };
  }
  if (extension === '.png') return { extension, mimeType: 'image/png' };
  if (extension === '.webp') return { extension, mimeType: 'image/webp' };
  throw new Error('仅支持 JPEG、PNG 和 WebP 图片；HEIC 请先导出为 JPEG。');
}

function assertPhotoSignature(
  bytes: Uint8Array,
  mimeType: ImagePostPhotoMaterial['mimeType'],
): void {
  const matches = mimeType === 'image/jpeg'
    ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mimeType === 'image/png'
      ? bytes.length >= 8
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a
      : bytes.length >= 12
        && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!matches) throw new Error('图片内容与文件格式不一致，未导入图文素材。');
}
