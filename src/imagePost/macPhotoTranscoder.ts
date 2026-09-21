import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';

import type { ImagePostPhotoTranscoder } from './photoImport';

const SIPS_EXECUTABLE = '/usr/bin/sips';
const DEFAULT_TIMEOUT_MS = 90_000;
const TEMPORARY_ROOT_NAME = 'ailu-photo-import';
const TEMPORARY_DIRECTORY_PREFIX = 'run-';
const TEMPORARY_DIRECTORY_MARKER = '.ailu-photo-import-v1';
const TEMPORARY_DIRECTORY_MARKER_TEXT = 'Ailu managed photo conversion v1\n';
const STALE_TEMPORARY_DIRECTORY_AGE_MS = 24 * 60 * 60 * 1000;

export interface SipsCommandRequest {
  executable: string;
  args: readonly string[];
  signal: AbortSignal;
}

export interface SipsCommandResult {
  stdout: string;
}

export type SipsCommandRunner = (request: SipsCommandRequest) => Promise<SipsCommandResult>;

export class MacPhotoTranscoder implements ImagePostPhotoTranscoder {
  private readonly temporaryRoot: string;
  private readonly timeoutMs: number;
  private readonly runCommand: SipsCommandRunner;

  constructor(options: {
    temporaryRoot?: string;
    timeoutMs?: number;
    runCommand?: SipsCommandRunner;
  } = {}) {
    this.temporaryRoot = options.temporaryRoot ?? path.join(os.tmpdir(), TEMPORARY_ROOT_NAME);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runCommand = options.runCommand ?? runSipsCommand;
  }

  async convertToJpeg(input: Parameters<ImagePostPhotoTranscoder['convertToJpeg']>[0]): Promise<Uint8Array> {
    if (input.signal?.aborted) throw new Error('照片转换已取消。');
    const timeout = new AbortController();
    let timedOut = false;
    let temporaryDirectory: string | null = null;
    const timer = setNodeTimeout(() => {
      timedOut = true;
      timeout.abort();
    }, this.timeoutMs);
    const onExternalAbort = () => timeout.abort();
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      await prepareTemporaryRoot(this.temporaryRoot);
      assertConversionActive(input.signal, timedOut, this.timeoutMs);
      await cleanupStaleDirectories(this.temporaryRoot);
      assertConversionActive(input.signal, timedOut, this.timeoutMs);
      temporaryDirectory = await mkdtemp(path.join(
        this.temporaryRoot,
        TEMPORARY_DIRECTORY_PREFIX,
      ));
      await chmod(temporaryDirectory, 0o700);
      const sourcePath = path.join(temporaryDirectory, `source.${input.sourceFormat}`);
      const outputPath = path.join(temporaryDirectory, 'converted.jpg');
      await writeFile(
        path.join(temporaryDirectory, TEMPORARY_DIRECTORY_MARKER),
        TEMPORARY_DIRECTORY_MARKER_TEXT,
        { mode: 0o600 },
      );
      await writeFile(sourcePath, input.bytes, { mode: 0o600 });
      assertConversionActive(input.signal, timedOut, this.timeoutMs);
      const metadata = await this.runCommand({
        executable: SIPS_EXECUTABLE,
        args: ['-g', 'pixelWidth', '-g', 'pixelHeight', sourcePath],
        signal: timeout.signal,
      });
      assertConversionActive(input.signal, timedOut, this.timeoutMs);
      const dimensions = parseSipsDimensions(metadata.stdout);
      const resizeArgs = Math.max(dimensions.width, dimensions.height) > 4096
        ? ['-Z', '4096']
        : [];
      await this.runCommand({
        executable: SIPS_EXECUTABLE,
        args: [
          '-s', 'format', 'jpeg',
          '-s', 'formatOptions', '92',
          ...resizeArgs,
          sourcePath,
          '--out', outputPath,
        ],
        signal: timeout.signal,
      });
      assertConversionActive(input.signal, timedOut, this.timeoutMs);
      const converted = await readFile(outputPath);
      assertConversionActive(input.signal, timedOut, this.timeoutMs);
      if (!converted.byteLength) throw new Error('系统没有生成 JPEG 文件。');
      return new Uint8Array(converted);
    } catch (error) {
      if (input.signal?.aborted) throw new Error('照片转换已取消。');
      if (timedOut) {
        throw new Error(`照片转换超过 ${Math.ceil(this.timeoutMs / 1000)} 秒，已停止且未导入。`);
      }
      if (error instanceof Error && error.message.startsWith('Ailu 照片转换临时目录不安全')) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') throw new Error('macOS 系统照片转换工具不可用。');
      throw new Error('照片转换失败；文件可能损坏或当前 macOS 不支持该格式。');
    } finally {
      clearNodeTimeout(timer);
      input.signal?.removeEventListener('abort', onExternalAbort);
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

async function prepareTemporaryRoot(temporaryRoot: string): Promise<void> {
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(temporaryRoot);
  const currentUid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (currentUid !== undefined && metadata.uid !== currentUid)) {
    throw new Error('Ailu 照片转换临时目录不安全，已停止导入。');
  }
  await chmod(temporaryRoot, 0o700);
}

async function cleanupStaleDirectories(temporaryRoot: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(temporaryRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMPORARY_DIRECTORY_AGE_MS;
  await Promise.all(entries.map(async entry => {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMPORARY_DIRECTORY_PREFIX)) return;
    const candidate = path.join(temporaryRoot, entry.name);
    try {
      const metadata = await lstat(candidate);
      const currentUid = process.getuid?.();
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || (currentUid !== undefined && metadata.uid !== currentUid)
        || metadata.mtimeMs >= cutoff) return;
      const marker = await readFile(path.join(candidate, TEMPORARY_DIRECTORY_MARKER), 'utf8');
      if (marker !== TEMPORARY_DIRECTORY_MARKER_TEXT) return;
      await rm(candidate, { recursive: true, force: true });
    } catch {
      // Stale cleanup is best-effort; the current conversion still uses a fresh directory.
    }
  }));
}

function assertConversionActive(
  signal: AbortSignal | undefined,
  timedOut: boolean,
  timeoutMs: number,
): void {
  if (signal?.aborted) throw new Error('照片转换已取消。');
  if (timedOut) throw new Error(`照片转换超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止且未导入。`);
}

function parseSipsDimensions(stdout: string): { width: number; height: number } {
  const width = Number(/pixelWidth:\s*(\d+)/u.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/u.exec(stdout)?.[1]);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('macOS 无法读取照片尺寸。');
  }
  return { width, height };
}

async function runSipsCommand(request: SipsCommandRequest): Promise<SipsCommandResult> {
  return await new Promise<SipsCommandResult>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let stdout = '';
    const child = spawn(request.executable, [...request.args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: request.signal,
    });
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      if (stdout.length < 4096) stdout += String(chunk).slice(0, 4096 - stdout.length);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    child.once('error', error => rejectOnce(error));
    child.once('close', (code, signal) => {
      if (code === 0) {
        if (!settled) {
          settled = true;
          resolve({ stdout });
        }
      }
      else rejectOnce(new Error(
        stderr.trim() || `sips 退出异常（code=${String(code)}，signal=${String(signal)}）`,
      ));
    });
  });
}
