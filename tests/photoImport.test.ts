import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { MacPhotoTranscoder } from '../src/imagePost/macPhotoTranscoder';
import {
  importImagePostPhotoFileBatch,
  ImagePostPhotoNormalizer,
  MAX_IMAGE_POST_PHOTO_INPUT_BYTES,
  readImagePostPhotoFile,
} from '../src/imagePost/photoImport';
import type { NormalizeImagePostPhotoInput } from '../src/imagePost/photoImport';

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
const TIFF_BYTES = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
const DNG_BYTES = Uint8Array.from([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x01, 0x00,
  0x12, 0xc6, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);
const HEIC_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x69, 0x66, 0x31,
]);
const HEIF_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x73, 0x66, 0x31,
]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('image post photo import normalization', () => {
  test('rejects an oversized Photos file before reading its bytes', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));

    await expect(readImagePostPhotoFile({
      name: '超大原片.dng',
      size: MAX_IMAGE_POST_PHOTO_INPUT_BYTES + 1,
      arrayBuffer,
    })).rejects.toThrow('超过 250 MiB');

    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  test('keeps successful photos when one file in a batch fails', async () => {
    const files = ['第一张.jpg', '损坏.jpg', '第三张.jpg'].map(name => ({
      name,
      size: JPEG_BYTES.byteLength,
      arrayBuffer: async () => JPEG_BYTES.buffer.slice(0),
    }));
    const importer = vi.fn(async (input: NormalizeImagePostPhotoInput) => {
      if (input.originalName === '损坏.jpg') throw new Error('图片“损坏.jpg”无法解码。');
      return input.originalName;
    });

    await expect(importImagePostPhotoFileBatch(files, importer)).resolves.toEqual({
      imported: [
        { fileName: '第一张.jpg', result: '第一张.jpg' },
        { fileName: '第三张.jpg', result: '第三张.jpg' },
      ],
      failures: ['图片“损坏.jpg”无法解码。'],
    });
    expect(importer).toHaveBeenCalledTimes(3);
  });

  test('converts a Photos DNG to a bounded JPEG while retaining its original display name', async () => {
    const convertToJpeg = vi.fn(async () => JPEG_BYTES);
    const readDimensions = vi.fn(async () => ({ width: 3072, height: 4096 }));
    const normalizer = new ImagePostPhotoNormalizer({
      transcoder: { convertToJpeg },
      dimensions: { readDimensions },
    });

    const normalized = await normalizer.normalize({
      bytes: DNG_BYTES,
      originalName: 'IMG_7715.dng',
    });

    expect(normalized).toEqual({
      bytes: JPEG_BYTES,
      originalName: 'IMG_7715.dng',
      storageFileName: 'IMG_7715.jpg',
      width: 3072,
      height: 4096,
      converted: true,
      sourceFormat: 'dng',
    });
    expect(convertToJpeg).toHaveBeenCalledWith({
      bytes: DNG_BYTES,
      sourceFormat: 'dng',
      signal: undefined,
    });
    expect(readDimensions).toHaveBeenCalledWith(JPEG_BYTES, 'image/jpeg');
  });

  test('keeps ordinary JPEG bytes unchanged and never calls the RAW transcoder', async () => {
    const convertToJpeg = vi.fn();
    const normalizer = new ImagePostPhotoNormalizer({
      transcoder: { convertToJpeg },
      dimensions: { readDimensions: async () => ({ width: 1200, height: 1600 }) },
    });

    const normalized = await normalizer.normalize({
      bytes: JPEG_BYTES,
      originalName: '旅行照片.jpeg',
    });

    expect(normalized).toMatchObject({
      bytes: JPEG_BYTES,
      originalName: '旅行照片.jpeg',
      storageFileName: '旅行照片.jpeg',
      converted: false,
      sourceFormat: 'jpeg',
    });
    expect(convertToJpeg).not.toHaveBeenCalled();
  });

  test.each([
    ['HEIC', '旅行.heic', HEIC_BYTES, 'heic'],
    ['HEIF', '旅行.heif', HEIF_BYTES, 'heif'],
  ] as const)('converts Photos %s files through the same JPEG boundary', async (
    _label,
    originalName,
    bytes,
    sourceFormat,
  ) => {
    const convertToJpeg = vi.fn(async () => JPEG_BYTES);
    const normalizer = new ImagePostPhotoNormalizer({
      transcoder: { convertToJpeg },
      dimensions: { readDimensions: async () => ({ width: 3024, height: 4032 }) },
    });

    await expect(normalizer.normalize({ bytes, originalName })).resolves.toMatchObject({
      originalName,
      storageFileName: '旅行.jpg',
      sourceFormat,
      converted: true,
    });
  });

  test('rejects disguised RAW files and oversized input before invoking sips', async () => {
    const convertToJpeg = vi.fn(async () => JPEG_BYTES);
    const normalizer = new ImagePostPhotoNormalizer({
      transcoder: { convertToJpeg },
      dimensions: { readDimensions: async () => ({ width: 1, height: 1 }) },
    });

    await expect(normalizer.normalize({
      bytes: TIFF_BYTES,
      originalName: '伪装.dng',
    })).rejects.toThrow('内容与文件格式不一致');
    const limited = new ImagePostPhotoNormalizer({
      transcoder: { convertToJpeg },
      dimensions: { readDimensions: async () => ({ width: 1, height: 1 }) },
      maxInputBytes: 7,
    });
    await expect(limited.normalize({
      bytes: DNG_BYTES,
      originalName: '过大.dng',
    })).rejects.toThrow('超过 7 字节');
    expect(convertToJpeg).not.toHaveBeenCalled();
  });
});

describe('macOS Photos transcoder', () => {
  test('removes only stale Ailu conversion directories before importing a new photo', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ailu-photo-test-'));
    temporaryDirectories.push(temporaryRoot);
    const stale = path.join(temporaryRoot, 'run-stale');
    const unsigned = path.join(temporaryRoot, 'run-not-ailu');
    const unrelated = path.join(temporaryRoot, 'other-app-data');
    await mkdir(stale);
    await mkdir(unsigned);
    await mkdir(unrelated);
    await writeFile(path.join(stale, '.ailu-photo-import-v1'), 'Ailu managed photo conversion v1\n');
    await writeFile(path.join(stale, 'source.dng'), DNG_BYTES);
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(stale, twoDaysAgo, twoDaysAgo);
    await utimes(unsigned, twoDaysAgo, twoDaysAgo);
    const transcoder = new MacPhotoTranscoder({
      temporaryRoot,
      runCommand: async request => {
        if (request.args[0] === '-g') return { stdout: 'pixelWidth: 1200\npixelHeight: 1600\n' };
        const outputIndex = request.args.indexOf('--out') + 1;
        await writeFile(request.args[outputIndex], JPEG_BYTES);
        return { stdout: '' };
      },
    });

    await transcoder.convertToJpeg({ bytes: DNG_BYTES, sourceFormat: 'dng' });

    expect(await readdir(temporaryRoot)).toEqual(['other-app-data', 'run-not-ailu']);
  });

  test('uses bounded sips conversion and removes the private temporary copy after success', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ailu-photo-test-'));
    temporaryDirectories.push(temporaryRoot);
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const transcoder = new MacPhotoTranscoder({
      temporaryRoot,
      runCommand: async request => {
        calls.push({ executable: request.executable, args: request.args });
        if (request.args[0] === '-g') return { stdout: 'pixelWidth: 3024\npixelHeight: 4032\n' };
        const outputIndex = request.args.indexOf('--out') + 1;
        await writeFile(request.args[outputIndex], JPEG_BYTES);
        return { stdout: '' };
      },
    });

    await expect(transcoder.convertToJpeg({
      bytes: DNG_BYTES,
      sourceFormat: 'dng',
    })).resolves.toEqual(JPEG_BYTES);

    expect(calls).toHaveLength(2);
    expect(calls[1].executable).toBe('/usr/bin/sips');
    expect(calls[1].args).toEqual(expect.arrayContaining([
      '-s', 'format', 'jpeg', '-s', 'formatOptions', '92', '--out',
    ]));
    expect(calls[1].args).not.toContain('-Z');
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test('adds the 4096px bound only when the source is larger', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ailu-photo-test-'));
    temporaryDirectories.push(temporaryRoot);
    const calls: string[][] = [];
    const transcoder = new MacPhotoTranscoder({
      temporaryRoot,
      runCommand: async request => {
        calls.push([...request.args]);
        if (request.args[0] === '-g') return { stdout: 'pixelWidth: 8064\npixelHeight: 6048\n' };
        const outputIndex = request.args.indexOf('--out') + 1;
        await writeFile(request.args[outputIndex], JPEG_BYTES);
        return { stdout: '' };
      },
    });

    await transcoder.convertToJpeg({ bytes: DNG_BYTES, sourceFormat: 'dng' });

    expect(calls[1]).toEqual(expect.arrayContaining(['-Z', '4096']));
  });

  test('removes the original temporary bytes when sips fails', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ailu-photo-test-'));
    temporaryDirectories.push(temporaryRoot);
    const transcoder = new MacPhotoTranscoder({
      temporaryRoot,
      runCommand: async request => {
        if (request.args[0] === '-g') return { stdout: 'pixelWidth: 1200\npixelHeight: 1600\n' };
        const sourcePath = request.args[request.args.indexOf('92') + 1];
        expect(await readFile(sourcePath)).toEqual(DNG_BYTES);
        throw new Error('fixture failure');
      },
    });

    await expect(transcoder.convertToJpeg({
      bytes: DNG_BYTES,
      sourceFormat: 'dng',
    })).rejects.toThrow('照片转换失败');
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test('stops a hung conversion at the deadline and removes its temporary source', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ailu-photo-test-'));
    temporaryDirectories.push(temporaryRoot);
    const transcoder = new MacPhotoTranscoder({
      temporaryRoot,
      timeoutMs: 5,
      runCommand: async request => await new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });

    await expect(transcoder.convertToJpeg({
      bytes: DNG_BYTES,
      sourceFormat: 'dng',
    })).rejects.toThrow('已停止且未导入');
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test('stops an externally cancelled conversion and removes its temporary source', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ailu-photo-test-'));
    temporaryDirectories.push(temporaryRoot);
    const abortController = new AbortController();
    const transcoder = new MacPhotoTranscoder({
      temporaryRoot,
      runCommand: async request => await new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });
    const conversion = transcoder.convertToJpeg({
      bytes: DNG_BYTES,
      sourceFormat: 'dng',
      signal: abortController.signal,
    });
    abortController.abort();

    await expect(conversion).rejects.toThrow('照片转换已取消');
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
});
