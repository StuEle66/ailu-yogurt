import path from 'node:path';

export const MAX_IMAGE_POST_PHOTO_INPUT_BYTES = 250 * 1024 * 1024;

type SourceFormat = NormalizedImagePostPhoto['sourceFormat'];
type DirectSourceFormat = Extract<SourceFormat, 'jpeg' | 'png' | 'webp'>;
type ConvertedSourceFormat = Extract<SourceFormat, 'dng' | 'heic' | 'heif'>;

export interface NormalizeImagePostPhotoInput {
  bytes: Uint8Array;
  originalName: string;
  signal?: AbortSignal;
}

export interface ImagePostPhotoFileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ImagePostPhotoFileBatchResult<Result> {
  imported: Array<{ fileName: string; result: Result }>;
  failures: string[];
}

export interface NormalizedImagePostPhoto {
  bytes: Uint8Array;
  originalName: string;
  storageFileName: string;
  width: number;
  height: number;
  converted: boolean;
  sourceFormat: 'jpeg' | 'png' | 'webp' | 'dng' | 'heic' | 'heif';
}

export interface ImagePostPhotoTranscoder {
  convertToJpeg(input: {
    bytes: Uint8Array;
    sourceFormat: 'dng' | 'heic' | 'heif';
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
}

export interface ImagePostPhotoDimensionsReader {
  readDimensions(bytes: Uint8Array, mimeType: 'image/jpeg' | 'image/png' | 'image/webp'): Promise<{
    width: number;
    height: number;
  }>;
}

export class BrowserImagePostPhotoDimensionsReader implements ImagePostPhotoDimensionsReader {
  async readDimensions(
    bytes: Uint8Array,
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
  ): Promise<{ width: number; height: number }> {
    const body = new Uint8Array(bytes).buffer;
    const url = URL.createObjectURL(new Blob([body], { type: mimeType }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效。');
      return { width: image.naturalWidth, height: image.naturalHeight };
    } catch {
      throw new Error('图片无法解码，可能已损坏。');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export class ImagePostPhotoNormalizer {
  private readonly transcoder: ImagePostPhotoTranscoder;
  private readonly dimensions: ImagePostPhotoDimensionsReader;
  private readonly maxInputBytes: number;

  constructor(options: {
    transcoder: ImagePostPhotoTranscoder;
    dimensions: ImagePostPhotoDimensionsReader;
    maxInputBytes?: number;
  }) {
    this.transcoder = options.transcoder;
    this.dimensions = options.dimensions;
    this.maxInputBytes = options.maxInputBytes ?? MAX_IMAGE_POST_PHOTO_INPUT_BYTES;
  }

  async normalize(input: NormalizeImagePostPhotoInput): Promise<NormalizedImagePostPhoto> {
    const originalName = path.basename(input.originalName.trim());
    if (!originalName) throw new Error('照片文件名无效，未导入图文素材。');
    assertImagePostPhotoInputSize(input.bytes.byteLength, originalName, this.maxInputBytes);
    const sourceFormat = sourceFormatFor(originalName);
    assertSourceSignature(input.bytes, sourceFormat, originalName);
    const converted = isConvertedFormat(sourceFormat);
    const bytes = converted
      ? await this.transcoder.convertToJpeg({
        bytes: input.bytes,
        sourceFormat,
        signal: input.signal,
      })
      : input.bytes;
    if (converted) assertJpegSignature(bytes, `图片“${originalName}”转换结果无效。`);
    const mimeType = mimeTypeFor(converted ? 'jpeg' : sourceFormat);
    const dimensions = await this.dimensions.readDimensions(bytes, mimeType);
    if (!Number.isFinite(dimensions.width) || dimensions.width <= 0
      || !Number.isFinite(dimensions.height) || dimensions.height <= 0) {
      throw new Error(`图片“${originalName}”尺寸无效，未导入。`);
    }
    const parsed = path.parse(originalName);
    return {
      bytes,
      originalName,
      storageFileName: converted ? `${parsed.name}.jpg` : originalName,
      width: dimensions.width,
      height: dimensions.height,
      converted,
      sourceFormat,
    };
  }
}

export function assertImagePostPhotoInputSize(
  byteLength: number,
  originalName: string,
  maxInputBytes = MAX_IMAGE_POST_PHOTO_INPUT_BYTES,
): void {
  const safeName = path.basename(originalName.trim()) || '未命名照片';
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error(`图片“${safeName}”内容为空，未导入。`);
  }
  if (byteLength > maxInputBytes) {
    const limitMiB = Math.floor(maxInputBytes / (1024 * 1024));
    throw new Error(`图片“${safeName}”超过 ${limitMiB || maxInputBytes} ${limitMiB ? 'MiB' : '字节'}，未导入。`);
  }
}

export async function readImagePostPhotoFile(
  file: ImagePostPhotoFileLike,
): Promise<NormalizeImagePostPhotoInput> {
  assertImagePostPhotoInputSize(file.size, file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertImagePostPhotoInputSize(bytes.byteLength, file.name);
  return { bytes, originalName: file.name };
}

export async function importImagePostPhotoFileBatch<Result>(
  files: readonly ImagePostPhotoFileLike[],
  importer: (input: NormalizeImagePostPhotoInput) => Promise<Result>,
): Promise<ImagePostPhotoFileBatchResult<Result>> {
  const imported: ImagePostPhotoFileBatchResult<Result>['imported'] = [];
  const failures: string[] = [];
  for (const file of files) {
    try {
      const result = await importer(await readImagePostPhotoFile(file));
      imported.push({ fileName: file.name, result });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `“${file.name}”导入失败。`);
    }
  }
  return { imported, failures };
}

function sourceFormatFor(fileName: string): SourceFormat {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg';
  if (extension === '.png') return 'png';
  if (extension === '.webp') return 'webp';
  if (extension === '.dng') return 'dng';
  if (extension === '.heic') return 'heic';
  if (extension === '.heif') return 'heif';
  throw new Error(`图片“${fileName}”格式不支持；请选择 JPEG、PNG、WebP、DNG、HEIC 或 HEIF。`);
}

function isConvertedFormat(format: SourceFormat): format is ConvertedSourceFormat {
  return format === 'dng' || format === 'heic' || format === 'heif';
}

function mimeTypeFor(format: DirectSourceFormat): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  return 'image/webp';
}

function assertSourceSignature(bytes: Uint8Array, format: SourceFormat, fileName: string): void {
  const valid = format === 'jpeg'
    ? isJpeg(bytes)
    : format === 'png'
      ? isPng(bytes)
      : format === 'webp'
        ? isWebp(bytes)
        : format === 'dng'
          ? isDng(bytes)
          : isHeifFamily(bytes, format);
  if (!valid) throw new Error(`图片“${fileName}”内容与文件格式不一致，未导入。`);
}

function assertJpegSignature(bytes: Uint8Array, message: string): void {
  if (!isJpeg(bytes)) throw new Error(message);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12
    && ascii(bytes, 0, 4) === 'RIFF'
    && ascii(bytes, 8, 12) === 'WEBP';
}

function isDng(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false;
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49
    && bytes[2] === 0x2a && bytes[3] === 0x00;
  const bigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d
    && bytes[2] === 0x00 && bytes[3] === 0x2a;
  if (!littleEndian && !bigEndian) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset > bytes.byteLength - 2) return false;
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  const availableEntries = Math.floor((bytes.byteLength - ifdOffset - 2) / 12);
  const boundedEntryCount = Math.min(entryCount, availableEntries, 4096);
  for (let index = 0; index < boundedEntryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    const tag = view.getUint16(entryOffset, littleEndian);
    if (tag === 0xc612 || tag === 0xc613) return true;
  }
  return false;
}

function isHeifFamily(bytes: Uint8Array, format: 'heic' | 'heif'): boolean {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== 'ftyp') return false;
  const brands = new Set<string>();
  for (let offset = 8; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
    brands.add(ascii(bytes, offset, offset + 4));
  }
  const heicBrands = ['heic', 'heix', 'hevc', 'hevx'];
  if (format === 'heic') return heicBrands.some(brand => brands.has(brand));
  return [...heicBrands, 'mif1', 'msf1'].some(brand => brands.has(brand));
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}
