import type { PreparedArticle } from './types';
import { assertPreparedArticleReady } from './preparedArticleBuilder';
import { buildPreparedArticleClipboardPayload } from './preparedArticleBuilder';
import {
  CdpSession,
  DedicatedChromeController,
} from '../imagePost/chromeDriver';

export type WechatArticleEditorState = 'ready' | 'login-required' | 'page-changed';
export type WechatArticleSaveState = 'saved' | 'uncertain';

export interface WechatArticleBrowserDriver {
  openEditor(signal: AbortSignal): Promise<WechatArticleEditorState>;
  fillArticle(article: PreparedArticle, signal: AbortSignal): Promise<void>;
  verifyArticle(article: PreparedArticle, signal: AbortSignal): Promise<boolean>;
  saveDraft(signal: AbortSignal): Promise<WechatArticleSaveState>;
}

export type WechatArticleBrowserResult =
  | { status: 'saved' }
  | { status: 'login-required' }
  | { status: 'attention-required'; reason: 'page-changed' | 'verification-failed' | 'save-uncertain' }
  | { status: 'failed'; reason: string };

export function buildWechatArticleComposerUrl(homeUrl: string): string | null {
  try {
    const source = new URL(homeUrl);
    if (source.hostname !== 'mp.weixin.qq.com' || !source.pathname.startsWith('/cgi-bin/')) return null;
    const token = source.searchParams.get('token');
    if (!token) return null;
    const composer = new URL('https://mp.weixin.qq.com/cgi-bin/appmsg');
    composer.searchParams.set('t', 'media/appmsg_edit_v2');
    composer.searchParams.set('action', 'edit');
    composer.searchParams.set('isNew', '1');
    composer.searchParams.set('type', '10');
    composer.searchParams.set('createType', '0');
    composer.searchParams.set('token', token);
    composer.searchParams.set('lang', source.searchParams.get('lang') || 'zh_CN');
    return composer.toString();
  } catch {
    return null;
  }
}

export class WechatArticleBrowserAdapter {
  constructor(private readonly browser: WechatArticleBrowserDriver) {}

  async save(article: PreparedArticle, signal: AbortSignal): Promise<WechatArticleBrowserResult> {
    try {
      assertPreparedArticleReady(article);
      const state = await this.browser.openEditor(signal);
      if (state === 'login-required') return { status: 'login-required' };
      if (state !== 'ready') return { status: 'attention-required', reason: 'page-changed' };
      await this.browser.fillArticle(article, signal);
      if (!await this.browser.verifyArticle(article, signal)) {
        return { status: 'attention-required', reason: 'verification-failed' };
      }
      const saved = await this.browser.saveDraft(signal);
      return saved === 'saved'
        ? { status: 'saved' }
        : { status: 'attention-required', reason: 'save-uncertain' };
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

interface ArticleEditorSnapshot {
  url: string;
  text: string;
  title: string;
  digest: string;
  bodyText: string;
  imageCount: number;
  localImageCount: number;
  hasCover: boolean;
  hasTitle: boolean;
  hasEditor: boolean;
}

export class DedicatedChromeWechatArticleDriver implements WechatArticleBrowserDriver {
  private session: CdpSession | null = null;

  constructor(private readonly chrome: DedicatedChromeController) {}

  async openEditor(signal: AbortSignal): Promise<WechatArticleEditorState> {
    if (this.session && !await this.session.isHealthy()) {
      this.session.close();
      this.session = null;
    }
    if (!this.session) {
      this.session = await this.chrome.openPage('https://mp.weixin.qq.com/', signal);
      await this.session.send('Page.enable');
    }
    let snapshot = await this.snapshot(signal);
    if (/扫码登录|登录公众平台|使用账号登录/u.test(snapshot.text)) return 'login-required';
    if (!isWechatArticleComposerUrl(snapshot.url)) {
      const composerUrl = buildWechatArticleComposerUrl(snapshot.url);
      if (!composerUrl) return 'page-changed';
      const composer = await this.chrome.openFreshPage(composerUrl, signal);
      this.session.close();
      this.session = composer;
      await composer.send('Page.enable');
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      snapshot = await this.snapshot(signal);
      if (/扫码登录|登录公众平台|使用账号登录/u.test(snapshot.text)) return 'login-required';
      if (snapshot.hasTitle && snapshot.hasEditor) return 'ready';
      await wait(500, signal);
    }
    return 'page-changed';
  }

  async fillArticle(article: PreparedArticle, signal: AbortSignal): Promise<void> {
    const payload = buildPreparedArticleClipboardPayload(article);
    let hostedHtml = payload.html;
    for (const image of article.images) {
      const hostedUrl = await this.uploadWechatLibraryImage(image, signal);
      const dataUrl = `data:${image.mimeType};base64,${Buffer.from(image.body).toString('base64')}`;
      hostedHtml = hostedHtml.split(dataUrl).join(hostedUrl);
      await this.closeImageLibrary(signal);
    }
    await this.pasteArticle(hostedHtml, payload.plain, signal);
    await this.fillCover(article, signal);
    await this.setTextField(TITLE_SELECTORS, article.title, signal, true);
    if (article.digest.trim()) await this.setTextField(DIGEST_SELECTORS, article.digest, signal, false);
  }

  async verifyArticle(article: PreparedArticle, signal: AbortSignal): Promise<boolean> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await this.snapshot(signal);
      const expectedText = normalizeText(buildPreparedArticleClipboardPayload(article).plain);
      const actualText = normalizeText(snapshot.bodyText);
      const textMatches = expectedText.length === 0 || actualText.includes(expectedText);
      const digestMatches = !article.digest.trim() || snapshot.digest.trim() === article.digest.trim();
      if (
        snapshot.title.trim() === article.title.trim()
        && digestMatches
        && textMatches
        && snapshot.imageCount >= article.images.length
        && snapshot.localImageCount === 0
        && snapshot.hasCover
      ) return true;
      await wait(500, signal);
    }
    return false;
  }

  async saveDraft(signal: AbortSignal): Promise<WechatArticleSaveState> {
    const before = await this.snapshot(signal);
    const clicked = await this.evaluate<boolean>(`(() => {
      const labels = ['保存为草稿', '保存草稿', '保存'];
      const elements = [...document.querySelectorAll('button, a, [role="button"]')];
      const button = elements.find(element => labels.includes((element.textContent || '').trim()));
      if (!(button instanceof HTMLElement) || button.hasAttribute('disabled')) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error('公众号编辑器的“保存草稿”按钮已变化，Ailu 没有执行保存。');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(500, signal);
      const current = await this.snapshot(signal);
      if (/保存成功|已保存至草稿|草稿已保存/u.test(current.text)) return 'saved';
      if (current.url !== before.url && !/[?&]isNew=1(?:&|$)/u.test(current.url)) return 'saved';
    }
    return 'uncertain';
  }

  private async setTextField(
    selectors: readonly string[],
    value: string,
    signal: AbortSignal,
    required: boolean,
  ): Promise<void> {
    if (signal.aborted) throw abortError();
    const found = await this.evaluate<boolean>(`(() => {
      const roots = [document, ...[...document.querySelectorAll('iframe')]
        .map(frame => { try { return frame.contentDocument; } catch { return null; } }).filter(Boolean)];
      const selectors = ${JSON.stringify(selectors)};
      const element = roots.flatMap(root => selectors.map(selector => root.querySelector(selector))).find(Boolean);
      if (!element) return false;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        setter?.call(element, ${JSON.stringify(value)});
      } else {
        element.textContent = ${JSON.stringify(value)};
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!found && required) throw new Error('公众号文章标题输入框已变化，Ailu 已停止填写。');
  }

  private async pasteArticle(html: string, plain: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    const session = this.requireSession();
    const origin = new URL((await this.snapshot(signal)).url).origin;
    await session.send('Page.bringToFront');
    await session.send('Browser.grantPermissions', {
      origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    const prepared = await this.evaluate<{ x: number; y: number } | null>(`(async () => {
      const roots = [document, ...[...document.querySelectorAll('iframe')]
        .map(frame => { try { return frame.contentDocument; } catch { return null; } }).filter(Boolean)];
      const selectors = ${JSON.stringify(EDITOR_SELECTORS)};
      const editor = roots.flatMap(root => selectors.map(selector => root.querySelector(selector))).find(Boolean);
      if (!(editor instanceof HTMLElement)) return null;
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([${JSON.stringify(html)}], { type: 'text/html' }),
        'text/plain': new Blob([${JSON.stringify(plain)}], { type: 'text/plain' }),
      })]);
      const rect = editor.getBoundingClientRect();
      return { x: rect.left + Math.min(40, rect.width / 2), y: rect.top + Math.min(40, rect.height / 2) };
    })()`);
    if (!prepared) throw new Error('公众号正文编辑器已变化，Ailu 已停止填写。');
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prepared.x, y: prepared.y });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: prepared.x, y: prepared.y, button: 'left', clickCount: 1,
    });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: prepared.x, y: prepared.y, button: 'left', clickCount: 1,
    });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    const pasted = await this.evaluate<boolean>(`(() => {
      const roots = [document, ...[...document.querySelectorAll('iframe')]
        .map(frame => { try { return frame.contentDocument; } catch { return null; } }).filter(Boolean)];
      const selectors = ${JSON.stringify(EDITOR_SELECTORS)};
      const editor = roots.flatMap(root => selectors.map(selector => root.querySelector(selector))).find(Boolean);
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      const transfer = new DataTransfer();
      transfer.setData('text/html', ${JSON.stringify(html)});
      transfer.setData('text/plain', ${JSON.stringify(plain)});
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
      editor.dispatchEvent(event);
      return event.defaultPrevented || Boolean(editor.textContent?.trim());
    })()`);
    if (!pasted) throw new Error('公众号正文富文本粘贴失败，Ailu 已停止填写。');
    await wait(500, signal);
  }

  private async fillCover(article: PreparedArticle, signal: AbortSignal): Promise<void> {
    await this.uploadWechatLibraryImage(article.cover, signal);
    const selected = await this.waitForCondition(async () => this.evaluate<boolean>(`(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialog = [...document.querySelectorAll('.weui-desktop-dialog')].filter(visible).at(-1);
      if (!(dialog instanceof HTMLElement) || !dialog.querySelector('.weui-desktop-img-picker__item.selected')) return false;
      const next = [...dialog.querySelectorAll('button, a')]
        .find(element => (element.textContent || '').trim() === '下一步');
      if (!(next instanceof HTMLElement)) return false;
      next.click();
      return true;
    })()`), signal, 40);
    if (!selected) throw new Error('公众号封面上传后没有出现在图片库，Ailu 已停止填写。');

    const cropped = await this.waitForCondition(async () => this.evaluate<boolean>(`(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialog = [...document.querySelectorAll('.weui-desktop-dialog')].filter(visible).at(-1);
      if (!(dialog instanceof HTMLElement) || !/编辑封面/u.test(dialog.innerText || '')) return false;
      const confirm = [...dialog.querySelectorAll('button, a')]
        .find(element => (element.textContent || '').trim() === '确认');
      if (!(confirm instanceof HTMLElement)) return false;
      confirm.click();
      return true;
    })()`), signal, 20);
    if (!cropped) throw new Error('公众号封面裁剪窗口已变化，Ailu 已停止填写。');

    const applied = await this.waitForCondition(async () => this.evaluate<boolean>(`(() => {
      const cover = document.querySelector('#js_cover_area');
      if (!(cover instanceof HTMLElement)) return false;
      return [...cover.querySelectorAll('[style*="background-image"]')]
        .some(element => (element.getAttribute('style') || '').includes('https://'));
    })()`), signal, 20);
    if (!applied) throw new Error('公众号封面上传结果无法核对，Ailu 已停止填写。');
  }

  private async uploadWechatLibraryImage(
    image: { body: ArrayBuffer; fileName: string; mimeType: string },
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw abortError();
    const bytes = Buffer.from(image.body).toString('base64');
    const opened = await this.evaluate<boolean>(`(() => {
      const button = document.querySelector('#js_cover_area .js_imagedialog');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`);
    if (!opened) throw new Error('公众号图片库入口已变化，Ailu 已停止填写。');
    const uploaded = await this.waitForCondition(async () => this.evaluate<boolean>(`(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialog = [...document.querySelectorAll('.weui-desktop-dialog')].filter(visible).at(-1);
      if (!(dialog instanceof HTMLElement) || !/选择图片/u.test(dialog.innerText || '')) return false;
      const input = [...document.querySelectorAll('input[type="file"][multiple]')]
        .filter(candidate => /bmp/u.test(candidate.accept || '')).at(-1);
      if (!(input instanceof HTMLInputElement)) return false;
      const binary = atob(${JSON.stringify(bytes)});
      const body = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) body[index] = binary.charCodeAt(index);
      const file = new File([body], ${JSON.stringify(image.fileName || 'image.jpg')}, {
        type: ${JSON.stringify(image.mimeType || 'image/jpeg')},
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`), signal, 20);
    if (!uploaded) throw new Error('公众号图片库上传控件已变化，Ailu 已停止填写。');
    let hostedUrl = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      hostedUrl = await this.evaluate<string>(`(() => {
        const selected = document.querySelector('.weui-desktop-dialog .weui-desktop-img-picker__item.selected');
        const thumb = selected?.querySelector('.weui-desktop-img-picker__img-thumb');
        const style = thumb?.getAttribute('style') || '';
        return style.match(/url\\(["']?([^"')]+)/u)?.[1] || '';
      })()`);
      if (hostedUrl.startsWith('https://')) return hostedUrl;
      await wait(500, signal);
    }
    throw new Error('公众号图片上传后没有得到微信托管地址，Ailu 已停止填写。');
  }

  private async closeImageLibrary(signal: AbortSignal): Promise<void> {
    const closed = await this.evaluate<boolean>(`(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialog = [...document.querySelectorAll('.weui-desktop-dialog')].filter(visible).at(-1);
      const cancel = dialog && [...dialog.querySelectorAll('button, a')]
        .find(element => (element.textContent || '').trim() === '取消');
      if (!(cancel instanceof HTMLElement)) return false;
      cancel.click();
      return true;
    })()`);
    if (!closed) throw new Error('公众号图片库无法关闭，Ailu 已停止填写。');
    await wait(300, signal);
  }

  private async waitForCondition(
    check: () => Promise<boolean>,
    signal: AbortSignal,
    attempts: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await check()) return true;
      await wait(500, signal);
    }
    return false;
  }

  private snapshot(signal: AbortSignal): Promise<ArticleEditorSnapshot> {
    if (signal.aborted) throw abortError();
    return this.evaluate<ArticleEditorSnapshot>(`(() => {
      const roots = [document, ...[...document.querySelectorAll('iframe')]
        .map(frame => { try { return frame.contentDocument; } catch { return null; } }).filter(Boolean)];
      const read = selectors => {
        const element = roots.flatMap(root => selectors.map(selector => root.querySelector(selector))).find(Boolean);
        if (!element) return { present: false, value: '' };
        const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value : (element.textContent || '');
        return { present: true, value };
      };
      const title = read(${JSON.stringify(TITLE_SELECTORS)});
      const digest = read(${JSON.stringify(DIGEST_SELECTORS)});
      const editor = roots.flatMap(root => ${JSON.stringify(EDITOR_SELECTORS)}.map(selector => root.querySelector(selector))).find(Boolean);
      const images = editor ? [...editor.querySelectorAll('img:not(.ProseMirror-separator)')] : [];
      const cover = document.querySelector('#js_cover_area');
      const hasCover = cover instanceof HTMLElement && [...cover.querySelectorAll('[style*="background-image"]')]
        .some(element => (element.getAttribute('style') || '').includes('https://'));
      return {
        url: location.href,
        text: (document.body?.innerText || '').slice(0, 30000),
        title: title.value,
        digest: digest.value,
        bodyText: editor?.textContent || '',
        imageCount: images.length,
        localImageCount: images.filter(image => /^(?:data:|blob:|ailu-prepared-image:)/iu.test(image.getAttribute('src') || '')).length,
        hasCover,
        hasTitle: title.present,
        hasEditor: Boolean(editor),
      };
    })()`);
  }

  private evaluate<T>(expression: string): Promise<T> {
    return this.requireSession().send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }).then(result => {
      if (result.exceptionDetails) throw new Error('公众号后台页面脚本执行失败，Ailu 已停止填写。');
      return result.result.value;
    });
  }

  private requireSession(): CdpSession {
    if (!this.session) throw new Error('公众号专用 Chrome 尚未打开。');
    return this.session;
  }
}

const TITLE_SELECTORS = Object.freeze([
  '.title-editor__input .ProseMirror[contenteditable="true"]',
  '#title',
  'textarea[placeholder*="标题"]',
  'input[placeholder*="标题"]',
  '[data-placeholder*="标题"][contenteditable="true"]',
]);

const DIGEST_SELECTORS = Object.freeze([
  '#js_description',
  '#digest',
  'textarea[placeholder*="摘要"]',
  'textarea[placeholder*="描述"]',
]);

const EDITOR_SELECTORS = Object.freeze([
  '#ueditor_0 .ProseMirror[contenteditable="true"]',
  '.rich_media_content .ProseMirror[contenteditable="true"]',
  'body[contenteditable="true"]',
  '.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"][data-placeholder*="正文"]',
]);

function isWechatArticleComposerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === 'mp.weixin.qq.com'
      && url.pathname === '/cgi-bin/appmsg'
      && url.searchParams.get('t') === 'media/appmsg_edit_v2'
      && url.searchParams.get('type') === '10';
  } catch {
    return false;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function abortError(): Error {
  return Object.assign(new Error('公众号草稿操作已停止。'), { name: 'AbortError' });
}
