import { describe, expect, it, vi } from 'vitest';

import { PreparedArticleBuilder, type PreparedArticle } from '../src/publishing';
import { onePixelPng } from './fixtures/imageBytes';
import {
  buildWechatArticleComposerUrl,
  DedicatedChromeWechatArticleDriver,
  WechatArticleBrowserAdapter,
  type WechatArticleBrowserDriver,
  type WechatArticleEditorState,
  type WechatArticleSaveState,
} from '../src/publishing/wechatArticleBrowserAdapter';

async function article(digest?: string): Promise<PreparedArticle> {
  const body = onePixelPng();
  return new PreparedArticleBuilder().build({
    sourceHash: 'source',
    title: '测试文章',
    digest,
    html: '<p>测试正文</p>',
    cover: {
      id: 'cover',
      fileName: 'cover.png',
      mimeType: 'image/png',
      body,
      references: ['cover.png'],
    },
    images: [],
  });
}

function driver(overrides: Partial<WechatArticleBrowserDriver> = {}): WechatArticleBrowserDriver {
  return {
    openEditor: vi.fn(async (): Promise<WechatArticleEditorState> => 'ready'),
    fillArticle: vi.fn(async () => undefined),
    verifyArticle: vi.fn(async () => true),
    saveDraft: vi.fn(async (): Promise<WechatArticleSaveState> => 'saved'),
    ...overrides,
  };
}

describe('WeChat article browser adapter', () => {
  it('builds the long-article composer from an authenticated account token', () => {
    expect(buildWechatArticleComposerUrl(
      'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=test-token',
    )).toBe(
      'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media%2Fappmsg_edit_v2&action=edit&isNew=1&type=10&createType=0&token=test-token&lang=zh_CN',
    );
    expect(buildWechatArticleComposerUrl('https://mp.weixin.qq.com/')).toBeNull();
  });

  it('does not fill or save while login is required', async () => {
    const fillArticle = vi.fn(async () => undefined);
    const saveDraft = vi.fn(async (): Promise<WechatArticleSaveState> => 'saved');
    const browser = driver({
      openEditor: vi.fn(async (): Promise<WechatArticleEditorState> => 'login-required'),
      fillArticle,
      saveDraft,
    });
    const result = await new WechatArticleBrowserAdapter(browser).save(await article(), new AbortController().signal);
    expect(result).toEqual({ status: 'login-required' });
    expect(fillArticle).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('refuses to save when the frozen article cannot be verified in the editor', async () => {
    const saveDraft = vi.fn(async (): Promise<WechatArticleSaveState> => 'saved');
    const browser = driver({ verifyArticle: vi.fn(async () => false), saveDraft });
    const result = await new WechatArticleBrowserAdapter(browser).save(await article(), new AbortController().signal);
    expect(result).toEqual({ status: 'attention-required', reason: 'verification-failed' });
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('returns saved only after the editor confirms the draft save', async () => {
    const saveDraft = vi.fn(async (): Promise<WechatArticleSaveState> => 'saved');
    const browser = driver({ saveDraft });
    const result = await new WechatArticleBrowserAdapter(browser).save(await article(), new AbortController().signal);
    expect(result).toEqual({ status: 'saved' });
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it('preserves an uncertain browser page without retrying save', async () => {
    const saveDraft = vi.fn(async (): Promise<WechatArticleSaveState> => 'uncertain');
    const browser = driver({ saveDraft });
    const result = await new WechatArticleBrowserAdapter(browser).save(await article(), new AbortController().signal);
    expect(result).toEqual({ status: 'attention-required', reason: 'save-uncertain' });
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it('uses the current WeChat digest field and completes the cover picker workflow', async () => {
    const evaluated: string[] = [];
    const session = {
      isHealthy: vi.fn(async () => true),
      close: vi.fn(),
      send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method !== 'Runtime.evaluate') return {};
        const expression = typeof params.expression === 'string' ? params.expression : '';
        evaluated.push(expression);
        if (expression.includes('hasTitle: title.present')) {
          return {
            result: {
              value: {
                url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&type=10',
                text: '',
                title: '',
                bodyText: '',
                imageCount: 0,
                localImageCount: 0,
                hasTitle: true,
                hasEditor: true,
              },
            },
          };
        }
        if (expression.includes('style.match')) {
          return { result: { value: 'https://mmbiz.qpic.cn/test-cover.png' } };
        }
        return { result: { value: true } };
      }),
    };
    const chrome = {
      openPage: vi.fn(async () => session),
      openFreshPage: vi.fn(async () => session),
    };
    const prepared = await article('测试摘要');
    const browser = new DedicatedChromeWechatArticleDriver(chrome as never);

    expect(await browser.openEditor(new AbortController().signal)).toBe('ready');
    await browser.fillArticle(prepared, new AbortController().signal);

    const browserScripts = evaluated.join('\n');
    expect(session.send).toHaveBeenCalledWith('Page.bringToFront');
    expect(browserScripts).toContain('#js_description');
    expect(browserScripts).toContain('.title-editor__input .ProseMirror');
    expect(browserScripts).toContain('#ueditor_0 .ProseMirror');
    expect(browserScripts).toContain('#js_cover_area');
    expect(browserScripts).toContain('input[type="file"][multiple]');
    expect(browserScripts).toContain('下一步');
    expect(browserScripts).toContain('编辑封面');
    expect(browserScripts).toContain('确认');
  });
});
