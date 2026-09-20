import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { request as requestHttp } from 'node:http';
import path from 'node:path';

import type {
  ImagePostAdapterInput,
  ImagePostBrowserDriver,
  ImagePostComposerState,
  ImagePostDestination,
  ImagePostVerification,
} from './adapters';

interface BrowserProfile {
  editorUrl: string;
  titleSelectors: readonly string[];
  bodySelectors: readonly string[];
  terminalActionSelectors: readonly string[];
}

const PROFILES: Readonly<Record<ImagePostDestination, BrowserProfile>> = Object.freeze({
  rednote: Object.freeze({
    editorUrl: 'https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch&target=image',
    titleSelectors: Object.freeze(['input[placeholder*="填写标题"]', 'input[placeholder*="标题"]', 'input.d-text']),
    bodySelectors: Object.freeze(['.tiptap.ProseMirror', '.ProseMirror[contenteditable="true"]', '[contenteditable="true"]']),
    terminalActionSelectors: Object.freeze([]),
  }),
  'wechat-image': Object.freeze({
    editorUrl: 'https://mp.weixin.qq.com/',
    titleSelectors: Object.freeze(['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', '#title']),
    bodySelectors: Object.freeze(['textarea[placeholder*="描述"]', 'textarea[placeholder*="正文"]', '[contenteditable="true"]']),
    terminalActionSelectors: Object.freeze([]),
  }),
});

export function imagePostBrowserProfile(destination: ImagePostDestination): BrowserProfile {
  return PROFILES[destination];
}

export class DedicatedChromeImagePostDriver implements ImagePostBrowserDriver {
  private session: CdpSession | null = null;

  constructor(
    private readonly destination: ImagePostDestination,
    private readonly chrome: DedicatedChromeController,
  ) {}

  async openEditor(destination: ImagePostDestination, signal: AbortSignal): Promise<void> {
    if (destination !== this.destination) throw new Error('图文浏览器目标不匹配。');
    if (signal.aborted) throw abortError();
    if (!this.session) {
      this.session = await this.chrome.openPage(imagePostBrowserProfile(destination).editorUrl, signal);
      await this.session.send('Page.enable');
      await delay(1_200, signal);
    }
    if (destination === 'wechat-image') await this.openWechatImageComposerIfAvailable(signal);
  }

  async inspectEditor(signal: AbortSignal): Promise<ImagePostComposerState> {
    return waitForImagePostComposerState(
      async () => classifyImagePostComposerSnapshot(await this.snapshot(signal)),
      async () => delay(500, signal),
    );
  }

  async uploadImages(paths: readonly string[], signal: AbortSignal): Promise<void> {
    if (!paths.length) throw new Error('没有可上传的图文图片。');
    const session = this.requireSession();
    const document = await session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 2, pierce: true });
    const input = await session.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: 'input[type="file"]',
    });
    if (!input.nodeId) throw new Error('后台图片上传控件已变化，Ailu 已停止填写。');
    if (signal.aborted) throw abortError();
    await session.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [...paths] });
    await delay(2_000, signal);
  }

  async fillTitle(title: string, signal: AbortSignal): Promise<void> {
    await this.fillField(imagePostBrowserProfile(this.destination).titleSelectors, title, signal);
  }

  async fillBody(body: string, signal: AbortSignal): Promise<void> {
    await this.fillField(imagePostBrowserProfile(this.destination).bodySelectors, body, signal);
  }

  async fillTopics(topics: readonly string[], signal: AbortSignal): Promise<void> {
    const suffix = topics.map(topic => topic.trim().replace(/^#+/u, '')).filter(Boolean).map(topic => `#${topic}`).join(' ');
    if (!suffix) return;
    const profile = imagePostBrowserProfile(this.destination);
    await this.evaluate<void>(`(() => {
      const selectors = ${JSON.stringify(profile.bodySelectors)};
      const element = selectors.map(selector => document.querySelector(selector)).find(Boolean);
      if (!element) throw new Error('body-field-missing');
      const current = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value : (element.textContent || '');
      const topics = ${JSON.stringify(suffix)};
      if (current.includes(topics)) return;
      const next = current.trim() ? current.trimEnd() + '\\n\\n' + topics : topics;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        setter?.call(element, next);
      } else {
        element.textContent = next;
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: topics }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    if (signal.aborted) throw abortError();
  }

  async verifyContent(post: ImagePostAdapterInput, signal: AbortSignal): Promise<ImagePostVerification> {
    const snapshot = await this.snapshot(signal);
    const expectedTopics = post.topics.map(topic => `#${topic.replace(/^#+/u, '')}`);
    const copyMatches = snapshot.title.trim() === post.title.trim()
      && snapshot.body.includes(post.body.trim())
      && expectedTopics.every(topic => snapshot.body.includes(topic));
    if (!copyMatches) return 'mismatched';
    return snapshot.uploadedImageCount >= post.images.length ? 'matched' : 'indeterminate';
  }

  private async openWechatImageComposerIfAvailable(signal: AbortSignal): Promise<void> {
    const snapshot = await this.snapshot(signal);
    if (/扫码登录|登录公众平台/u.test(snapshot.text) || snapshot.fileInputCount > 0) return;
    await this.evaluate<void>(`(() => {
      const wanted = ['图片/文字', '图片消息', '小绿书'];
      const element = [...document.querySelectorAll('a,button,[role="button"]')]
        .find(node => wanted.some(label => (node.textContent || '').trim().includes(label)));
      if (element instanceof HTMLElement) element.click();
    })()`);
    await delay(1_000, signal);
  }

  private async fillField(selectors: readonly string[], value: string, signal: AbortSignal): Promise<void> {
    await this.evaluate<void>(`(() => {
      const element = ${JSON.stringify(selectors)}.map(selector => document.querySelector(selector)).find(Boolean);
      if (!element) throw new Error('field-missing');
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        setter?.call(element, ${JSON.stringify(value)});
      } else {
        element.textContent = ${JSON.stringify(value)};
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    if (signal.aborted) throw abortError();
  }

  private async snapshot(signal: AbortSignal): Promise<{
    url: string; text: string; fileInputCount: number; uploadedImageCount: number;
    hasTitle: boolean; hasBody: boolean; hasContent: boolean; title: string; body: string;
  }> {
    if (signal.aborted) throw abortError();
    const profile = imagePostBrowserProfile(this.destination);
    return this.evaluate(`(() => {
      const read = selectors => {
        const element = selectors.map(selector => document.querySelector(selector)).find(Boolean);
        if (!element) return { present: false, value: '' };
        const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value : (element.textContent || '');
        return { present: true, value };
      };
      const title = read(${JSON.stringify(profile.titleSelectors)});
      const body = read(${JSON.stringify(profile.bodySelectors)});
      return {
        url: location.href,
        text: (document.body?.innerText || '').slice(0, 20000),
        fileInputCount: document.querySelectorAll('input[type="file"]').length,
        uploadedImageCount: document.querySelectorAll('[class*="upload"] img, [class*="image"] img, [class*="material"] img').length,
        hasTitle: title.present,
        hasBody: body.present,
        hasContent: Boolean(title.value.trim() || body.value.trim()),
        title: title.value,
        body: body.value,
      };
    })()`);
  }

  private evaluate<T>(expression: string): Promise<T> {
    return this.requireSession().send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }).then(result => {
      if (result.exceptionDetails) throw new Error('后台页面字段已变化，Ailu 已停止填写。');
      return result.result.value;
    });
  }

  private requireSession(): CdpSession {
    if (!this.session) throw new Error('专用 Chrome 尚未打开。');
    return this.session;
  }
}

export function classifyImagePostComposerSnapshot(snapshot: {
  url: string;
  text: string;
  fileInputCount: number;
  uploadedImageCount: number;
  hasTitle: boolean;
  hasBody: boolean;
  hasContent: boolean;
}): ImagePostComposerState {
  if (/login|passport/u.test(snapshot.url) || /扫码登录|登录公众平台|手机验证码/u.test(snapshot.text)) {
    return 'login-required';
  }
  if (/验证码|安全验证|拖动滑块|异常访问/u.test(snapshot.text)) return 'captcha-required';
  if (snapshot.fileInputCount > 0
    && !snapshot.hasTitle
    && !snapshot.hasBody
    && /上传图文|上传图片/u.test(snapshot.text)) return 'empty';
  if (!snapshot.fileInputCount || (!snapshot.hasTitle && !snapshot.hasBody)) return 'page-changed';
  return snapshot.hasContent || snapshot.uploadedImageCount > 0 ? 'content-present' : 'empty';
}

export async function waitForImagePostComposerState(
  readState: () => Promise<ImagePostComposerState>,
  wait: () => Promise<void>,
  attempts = 20,
): Promise<ImagePostComposerState> {
  let state = await readState();
  for (let attempt = 1; state === 'page-changed' && attempt < attempts; attempt += 1) {
    await wait();
    state = await readState();
  }
  return state;
}

export class DedicatedChromeController {
  private endpoint = '';

  constructor(
    private readonly profileDirectory: string,
    private readonly executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ) {}

  async openPage(url: string, signal: AbortSignal): Promise<CdpSession> {
    await this.ensureEndpoint(signal);
    const targetsResponse = await requestLocalChrome(`${this.endpoint}/json/list`, 'GET', signal);
    if (targetsResponse.status >= 200 && targetsResponse.status < 300) {
      const existing = selectExistingImagePostTarget(
        JSON.parse(targetsResponse.body) as ChromeTarget[],
        url,
      );
      if (existing) return CdpSession.connect(existing.webSocketDebuggerUrl, signal);
    }
    const response = await requestLocalChrome(`${this.endpoint}/json/new?${encodeURIComponent(url)}`, 'PUT', signal);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`专用 Chrome 无法创建编辑页（${response.status}）。`);
    }
    const target = JSON.parse(response.body) as { webSocketDebuggerUrl?: string };
    if (!target.webSocketDebuggerUrl) throw new Error('专用 Chrome 没有返回可控制的编辑页。');
    return CdpSession.connect(target.webSocketDebuggerUrl, signal);
  }

  private async ensureEndpoint(signal: AbortSignal): Promise<void> {
    if (this.endpoint && await endpointAvailable(this.endpoint)) return;
    await mkdir(this.profileDirectory, { recursive: true });
    const activePort = path.join(this.profileDirectory, 'DevToolsActivePort');
    const existing = await readActivePort(activePort);
    if (existing && await endpointAvailable(existing)) {
      this.endpoint = existing;
      return;
    }
    const child = spawn(this.executable, [
      '--remote-debugging-port=0',
      '--remote-allow-origins=app://obsidian.md',
      `--user-data-dir=${this.profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError();
      const endpoint = await readActivePort(activePort);
      if (endpoint && await endpointAvailable(endpoint)) {
        this.endpoint = endpoint;
        return;
      }
      await delay(250, signal);
    }
    throw new Error('专用 Chrome 启动超时，请确认已安装 Google Chrome。');
  }
}

export interface ChromeTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export function selectExistingImagePostTarget(
  targets: readonly ChromeTarget[],
  requestedUrl: string,
): { webSocketDebuggerUrl: string } | null {
  const requested = new URL(requestedUrl);
  const candidates = targets.flatMap((target, index) => {
    if (target.type !== 'page' || !target.url || !target.webSocketDebuggerUrl) return [];
    try {
      const current = new URL(target.url);
      const websocket = new URL(target.webSocketDebuggerUrl);
      if (current.origin !== requested.origin
        || websocket.protocol !== 'ws:'
        || websocket.hostname !== '127.0.0.1') return [];
      const authenticatedWechat = requested.hostname === 'mp.weixin.qq.com'
        && current.pathname.startsWith('/cgi-bin/');
      return [{ target, index, score: authenticatedWechat ? 100 : 0 }];
    } catch { return []; }
  });
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = candidates[0]?.target.webSocketDebuggerUrl;
  return selected ? { webSocketDebuggerUrl: selected } : null;
}

class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Chrome 调用失败。'));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('专用 Chrome 连接已断开。'));
      this.pending.clear();
    });
  }

  static connect(url: string, signal: AbortSignal): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const abort = (): void => { socket.close(); reject(abortError()); };
      signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => {
        signal.removeEventListener('abort', abort);
        resolve(new CdpSession(socket));
      }, { once: true });
      socket.addEventListener('error', () => {
        signal.removeEventListener('abort', abort);
        reject(new Error('无法连接专用 Chrome。'));
      }, { once: true });
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function readActivePort(filePath: string): Promise<string | null> {
  try {
    const [port] = (await readFile(filePath, 'utf8')).split(/\r?\n/u);
    return /^\d+$/u.test(port) ? `http://127.0.0.1:${port}` : null;
  } catch { return null; }
}

async function endpointAvailable(endpoint: string): Promise<boolean> {
  try {
    const response = await requestLocalChrome(`${endpoint}/json/version`, 'GET', AbortSignal.timeout(2_000));
    return response.status >= 200 && response.status < 300;
  }
  catch { return false; }
}

function requestLocalChrome(
  target: string,
  method: 'GET' | 'PUT',
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    return Promise.reject(new Error('专用 Chrome 仅允许使用本机调试端口。'));
  }
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      action();
    };
    const abort = (): void => { chromeRequest.destroy(abortError()); };
    const chromeRequest = requestHttp(url, { method, headers: { accept: 'application/json' } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          chromeRequest.destroy(new Error('专用 Chrome 返回的数据异常过大。'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(() => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      })));
    });
    chromeRequest.setTimeout(5_000, () => chromeRequest.destroy(new Error('专用 Chrome 本机连接超时。')));
    chromeRequest.on('error', error => finish(() => reject(error)));
    signal.addEventListener('abort', abort, { once: true });
    chromeRequest.end();
  });
}

function abortError(): Error {
  return new DOMException('已停止图文后台填写。', 'AbortError');
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}
