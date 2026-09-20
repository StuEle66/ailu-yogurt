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
  fileInputSelector: string;
  uploadedImageSelector: string;
  titleSelectors: readonly string[];
  bodySelectors: readonly string[];
  terminalActionSelectors: readonly string[];
}

const PROFILES: Readonly<Record<ImagePostDestination, BrowserProfile>> = Object.freeze({
  rednote: Object.freeze({
    editorUrl: 'https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch&target=image',
    fileInputSelector: 'input[type="file"]',
    uploadedImageSelector: '[class*="upload"] img, [class*="image"] img, [class*="material"] img',
    titleSelectors: Object.freeze(['input[placeholder*="填写标题"]', 'input[placeholder*="标题"]', 'input.d-text']),
    bodySelectors: Object.freeze(['.tiptap.ProseMirror', '.ProseMirror[contenteditable="true"]', '[contenteditable="true"]']),
    terminalActionSelectors: Object.freeze([]),
  }),
  'wechat-image': Object.freeze({
    editorUrl: 'https://mp.weixin.qq.com/',
    fileInputSelector: '.js_upload_btn_container input[type="file"]',
    uploadedImageSelector: '.image-selector__bottom-list-item',
    titleSelectors: Object.freeze([
      '[data-placeholder*="标题"].ProseMirror[contenteditable="true"]',
      'input[placeholder*="标题"]',
      'textarea[placeholder*="标题"]',
      '#title',
    ]),
    bodySelectors: Object.freeze([
      '.share-text__input .ProseMirror',
      'textarea[placeholder*="描述"]',
      'textarea[placeholder*="正文"]',
      '[contenteditable="true"]',
    ]),
    terminalActionSelectors: Object.freeze([]),
  }),
});

export const WECHAT_IMAGE_COMPOSER_LABELS = Object.freeze(['贴图', '图片/文字', '图片消息', '小绿书']);
export const WECHAT_IMAGE_COMPOSER_ENTRY_SELECTOR = 'a,button,[role="button"],.new-creation__menu-item';

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
      selector: imagePostBrowserProfile(this.destination).fileInputSelector,
    });
    if (!input.nodeId) throw new Error('后台图片上传控件已变化，Ailu 已停止填写。');
    if (signal.aborted) throw abortError();
    await session.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [...paths] });
    const appeared = await waitForUploadedImageCount(
      async () => (await this.snapshot(signal)).uploadedImageCount,
      async () => delay(500, signal),
      paths.length,
    );
    if (!appeared) throw new Error('后台图片上传等待超时，请在保留的页面中检查已上传内容。');
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
    if (/扫码登录|登录公众平台/u.test(snapshot.text)) return;
    try {
      if (isWechatImageComposerUrl(new URL(snapshot.url))) return;
    } catch {
      throw new Error('微信贴图后台返回了无法识别的页面地址。');
    }
    const point = await this.evaluate<{ x: number; y: number } | null>(`(async () => {
      const wanted = ${JSON.stringify(WECHAT_IMAGE_COMPOSER_LABELS)};
      const element = [...document.querySelectorAll(${JSON.stringify(WECHAT_IMAGE_COMPOSER_ENTRY_SELECTOR)})]
        .find(node => wanted.some(label => (node.textContent || '').trim().includes(label)));
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = element.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      if (rect.width <= 0 || rect.height <= 0
        || rect.right <= 0 || rect.bottom <= 0
        || rect.left >= viewportWidth || rect.top >= viewportHeight) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!point) return;
    const session = this.requireSession();
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', button: 'left', clickCount: 1, ...point,
    });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', button: 'left', clickCount: 1, ...point,
    });
    const composer = await this.chrome.waitForWechatImageComposer(signal);
    if (composer) {
      this.session = composer;
      await composer.send('Page.enable');
      await delay(500, signal);
    }
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
        uploadedImageCount: document.querySelectorAll(${JSON.stringify(profile.uploadedImageSelector)}).length,
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
  title?: string;
  body?: string;
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
  const wechatPlaceholderOnly = /mp\.weixin\.qq\.com/u.test(snapshot.url)
    && !(snapshot.title || '').trim()
    && (snapshot.body || '').trim() === '填写描述信息，让大家了解更多内容';
  return (snapshot.hasContent && !wechatPlaceholderOnly) || snapshot.uploadedImageCount > 0
    ? 'content-present'
    : 'empty';
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

export async function waitForUploadedImageCount(
  readCount: () => Promise<number>,
  wait: () => Promise<void>,
  expectedCount: number,
  attempts = 40,
): Promise<boolean> {
  let count = await readCount();
  for (let attempt = 1; count < expectedCount && attempt < attempts; attempt += 1) {
    await wait();
    count = await readCount();
  }
  return count >= expectedCount;
}

export class DedicatedChromeController {
  private endpoint = '';
  private endpointPromise: Promise<void> | null = null;

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

  async waitForWechatImageComposer(signal: AbortSignal): Promise<CdpSession | null> {
    await this.ensureEndpoint(signal);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await requestLocalChrome(`${this.endpoint}/json/list`, 'GET', signal);
      if (response.status >= 200 && response.status < 300) {
        const target = selectWechatImageComposerTarget(JSON.parse(response.body) as ChromeTarget[]);
        if (target) return CdpSession.connect(target.webSocketDebuggerUrl, signal);
      }
      await delay(500, signal);
    }
    return null;
  }

  private async ensureEndpoint(signal: AbortSignal): Promise<void> {
    if (!this.endpointPromise) {
      this.endpointPromise = this.establishEndpoint(AbortSignal.timeout(20_000))
        .finally(() => { this.endpointPromise = null; });
    }
    await waitForOperation(this.endpointPromise, signal);
  }

  private async establishEndpoint(signal: AbortSignal): Promise<void> {
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
      const wechatImageComposer = requested.hostname === 'mp.weixin.qq.com'
        && isWechatImageComposerUrl(current);
      return [{ target, index, score: wechatImageComposer ? 200 : authenticatedWechat ? 100 : 0 }];
    } catch { return []; }
  });
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = candidates[0]?.target.webSocketDebuggerUrl;
  return selected ? { webSocketDebuggerUrl: selected } : null;
}

export function selectWechatImageComposerTarget(
  targets: readonly ChromeTarget[],
): { webSocketDebuggerUrl: string } | null {
  const selected = targets.find(target => {
    if (target.type !== 'page' || !target.url || !target.webSocketDebuggerUrl) return false;
    try {
      const current = new URL(target.url);
      const websocket = new URL(target.webSocketDebuggerUrl);
      return isWechatImageComposerUrl(current)
        && websocket.protocol === 'ws:'
        && websocket.hostname === '127.0.0.1';
    } catch { return false; }
  })?.webSocketDebuggerUrl;
  return selected ? { webSocketDebuggerUrl: selected } : null;
}

function isWechatImageComposerUrl(url: URL): boolean {
  return url.hostname === 'mp.weixin.qq.com'
    && url.pathname === '/cgi-bin/appmsg'
    && url.searchParams.get('t') === 'media/appmsg_edit_v2'
    && url.searchParams.get('type') === '77';
}

interface CdpSessionTimeouts {
  connectTimeoutMs: number;
  commandTimeoutMs: number;
}

const DEFAULT_CDP_TIMEOUTS: CdpSessionTimeouts = Object.freeze({
  connectTimeoutMs: 10_000,
  commandTimeoutMs: 15_000,
});

export class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(
    private readonly socket: WebSocket,
    private readonly commandTimeoutMs: number,
  ) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Chrome 调用失败。'));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('专用 Chrome 连接已断开。'));
      }
      this.pending.clear();
    });
  }

  static connect(
    url: string,
    signal: AbortSignal,
    timeouts: CdpSessionTimeouts = DEFAULT_CDP_TIMEOUTS,
  ): Promise<CdpSession> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        action();
      };
      const abort = (): void => finish(() => { socket.close(); reject(abortError()); });
      const timer = setTimeout(() => finish(() => {
        socket.close();
        reject(new Error('连接专用 Chrome 超时。'));
      }), timeouts.connectTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => {
        finish(() => resolve(new CdpSession(socket, timeouts.commandTimeoutMs)));
      }, { once: true });
      socket.addEventListener('error', () => {
        finish(() => reject(new Error('无法连接专用 Chrome。')));
      }, { once: true });
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`专用 Chrome 调用超时：${method}`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('专用 Chrome 调用失败。'));
      }
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

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error('专用 Chrome 操作失败。'));
      },
    );
  });
}
