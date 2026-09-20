import { describe, expect, test } from 'vitest';

import {
  createXiaohongshuImagePostAdapter,
  createWechatImagePostAdapter,
  ImagePostHandoffCoordinator,
  type ImagePostAdapterInput,
  type ImagePostBrowserDriver,
  type ImagePostComposerState,
  type ImagePostVerification,
} from '../src/imagePost/adapters';

const POST: ImagePostAdapterInput = {
  preparedId: 'post-v1',
  title: '清华研一这一年',
  body: '这是已经冻结的发布文案。',
  topics: ['研究生日常', 'AI工具'],
  images: [
    { id: 'card-1', path: '/private/cards/01.png' },
    { id: 'photo-2', path: '/private/photos/02.jpg' },
  ],
};

class RecordingBrowserDriver implements ImagePostBrowserDriver {
  readonly operations: string[] = [];

  constructor(
    private state: ImagePostComposerState = 'empty',
    private verification: ImagePostVerification = 'matched',
  ) {}

  setState(state: ImagePostComposerState, verification: ImagePostVerification = 'matched'): void {
    this.state = state;
    this.verification = verification;
  }

  async openEditor(destination: 'rednote' | 'wechat-image'): Promise<void> {
    this.operations.push(`open:${destination}`);
  }

  async inspectEditor(): Promise<ImagePostComposerState> {
    this.operations.push('inspect');
    return this.state;
  }

  async uploadImages(paths: readonly string[]): Promise<void> {
    this.operations.push(`images:${paths.join(',')}`);
    this.state = 'content-present';
  }

  async fillTitle(title: string): Promise<void> {
    this.operations.push(`title:${title}`);
  }

  async fillBody(body: string): Promise<void> {
    this.operations.push(`body:${body}`);
  }

  async fillTopics(topics: readonly string[]): Promise<void> {
    this.operations.push(`topics:${topics.join(',')}`);
  }

  async verifyContent(): Promise<ImagePostVerification> {
    this.operations.push('verify');
    return this.verification;
  }
}

class FailingBrowserDriver extends RecordingBrowserDriver {
  constructor(private readonly failurePoint: 'open' | 'after-upload') {
    super();
  }

  override async openEditor(destination: 'rednote' | 'wechat-image'): Promise<void> {
    await super.openEditor(destination);
    if (this.failurePoint === 'open') throw new Error('browser unavailable');
  }

  override async uploadImages(paths: readonly string[]): Promise<void> {
    await super.uploadImages(paths);
    if (this.failurePoint === 'after-upload') throw new Error('stream disconnected');
  }
}

class BlockingOpenBrowserDriver extends RecordingBrowserDriver {
  override async openEditor(
    _destination: 'rednote' | 'wechat-image',
    signal?: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(
        signal.reason instanceof Error ? signal.reason : new Error('aborted'),
      ), { once: true });
    });
  }
}

class BlockingBrowserDriver extends RecordingBrowserDriver {
  private releaseUpload!: () => void;
  private readonly uploadGate = new Promise<void>(resolve => {
    this.releaseUpload = resolve;
  });

  override async uploadImages(paths: readonly string[]): Promise<void> {
    await super.uploadImages(paths);
    await this.uploadGate;
  }

  release(): void {
    this.releaseUpload();
  }
}

class AbortingAfterUploadBrowserDriver extends RecordingBrowserDriver {
  constructor(private readonly controller: AbortController) {
    super();
  }

  override async uploadImages(paths: readonly string[]): Promise<void> {
    await super.uploadImages(paths);
    this.controller.abort('user-stop');
    throw new Error('upload interrupted');
  }
}

class AbortingAfterInspectBrowserDriver extends RecordingBrowserDriver {
  constructor(private readonly controller: AbortController) {
    super();
  }

  override async inspectEditor(): Promise<ImagePostComposerState> {
    const state = await super.inspectEditor();
    this.controller.abort('user-stop');
    return state;
  }
}

describe('image post browser adapters', () => {
  test('fills a clean Xiaohongshu editor and stops for manual review', async () => {
    const browser = new RecordingBrowserDriver();
    const adapter = createXiaohongshuImagePostAdapter(browser);

    await expect(adapter.prepareEditor(POST)).resolves.toEqual({
      destination: 'rednote',
      status: 'editor-filled',
      reason: null,
      message: '内容已填入小红书编辑器，请检查后手动发布。',
    });
    expect(browser.operations).toEqual([
      'open:rednote',
      'inspect',
      'images:/private/cards/01.png,/private/photos/02.jpg',
      'title:清华研一这一年',
      'body:这是已经冻结的发布文案。',
      'topics:研究生日常,AI工具',
      'verify',
    ]);
  });

  test('reports platform-specific progress through editor preparation', async () => {
    const adapter = createWechatImagePostAdapter(new RecordingBrowserDriver());
    const stages: string[] = [];

    await adapter.prepareEditor(POST, {
      onProgress: progress => stages.push(`${progress.destination}:${progress.stage}`),
    });

    expect(stages).toEqual([
      'wechat-image:opening',
      'wechat-image:uploading',
      'wechat-image:filling-title',
      'wechat-image:filling-body',
      'wechat-image:filling-topics',
      'wechat-image:verifying',
      'wechat-image:completed',
    ]);
  });

  test('pauses for login before changing the Xiaohongshu editor', async () => {
    const browser = new RecordingBrowserDriver('login-required');
    const adapter = createXiaohongshuImagePostAdapter(browser);

    await expect(adapter.prepareEditor(POST)).resolves.toEqual({
      destination: 'rednote',
      status: 'attention-required',
      reason: 'login-required',
      message: '小红书登录已失效，请在保留的浏览器窗口中重新登录。',
    });
    expect(browser.operations).toEqual(['open:rednote', 'inspect']);
  });

  test.each([
    ['captcha-required', 'captcha-required', '微信贴图需要完成验证码，请在保留的浏览器窗口中处理。'],
    ['page-changed', 'page-changed', '微信贴图后台页面结构已变化，Ailu 已停止填写，请检查页面。'],
  ] as const)(
    'pauses without mutation when the editor reports %s',
    async (state, reason, message) => {
      const browser = new RecordingBrowserDriver(state);
      const adapter = createWechatImagePostAdapter(browser);

      await expect(adapter.prepareEditor(POST)).resolves.toEqual({
        destination: 'wechat-image',
        status: 'attention-required',
        reason,
        message,
      });
      expect(browser.operations).toEqual(['open:wechat-image', 'inspect']);
    },
  );

  test('recognizes an already-filled editor without uploading the images again', async () => {
    const browser = new RecordingBrowserDriver('content-present', 'matched');
    const adapter = createXiaohongshuImagePostAdapter(browser);

    await expect(adapter.prepareEditor(POST)).resolves.toMatchObject({
      destination: 'rednote',
      status: 'editor-filled',
      reason: null,
    });
    expect(browser.operations).toEqual(['open:rednote', 'inspect', 'verify']);
  });

  test.each(['mismatched', 'indeterminate'] as const)(
    'keeps existing editor content untouched when verification is %s',
    async verification => {
      const browser = new RecordingBrowserDriver('content-present', verification);
      const adapter = createXiaohongshuImagePostAdapter(browser);

      await expect(adapter.prepareEditor(POST)).resolves.toEqual({
        destination: 'rednote',
        status: 'attention-required',
        reason: 'uncertain-result',
        message: '小红书编辑器已有内容，但无法确认与本次内容一致。Ailu 未重复上传，请人工核对。',
      });
      expect(browser.operations).toEqual(['open:rednote', 'inspect', 'verify']);
    },
  );

  test('reports a browser failure before any editor mutation', async () => {
    const adapter = createXiaohongshuImagePostAdapter(new FailingBrowserDriver('open'));

    await expect(adapter.prepareEditor(POST)).resolves.toEqual({
      destination: 'rednote',
      status: 'failed',
      reason: 'browser-failure',
      message: '小红书浏览器操作失败，请查看本地诊断日志。',
    });
  });

  test('ends a platform task at its deadline before any upload starts', async () => {
    const adapter = createWechatImagePostAdapter(new BlockingOpenBrowserDriver());

    await expect(adapter.prepareEditor(POST, { taskTimeoutMs: 20 })).resolves.toEqual({
      destination: 'wechat-image',
      status: 'failed',
      reason: 'browser-failure',
      message: '微信贴图后台填写超时，尚未上传图片，可以安全重试。',
    });
  });

  test('treats a disconnect after upload starts as an uncertain result', async () => {
    const adapter = createXiaohongshuImagePostAdapter(new FailingBrowserDriver('after-upload'));

    await expect(adapter.prepareEditor(POST)).resolves.toEqual({
      destination: 'rednote',
      status: 'attention-required',
      reason: 'uncertain-result',
      message: '小红书填写过程中断，后台可能已有部分内容。Ailu 不会自动重传，请先检查保留的页面。',
    });
  });

  test('returns cancelled when the caller aborts before opening the editor', async () => {
    const controller = new AbortController();
    controller.abort('user-stop');
    const adapter = createWechatImagePostAdapter(new RecordingBrowserDriver());

    await expect(adapter.prepareEditor(POST, { signal: controller.signal })).resolves.toEqual({
      destination: 'wechat-image',
      status: 'cancelled',
      reason: 'cancelled',
      message: '已停止填写微信贴图编辑器。',
    });
  });

  test('stops before mutation when cancellation arrives after page inspection', async () => {
    const controller = new AbortController();
    const browser = new AbortingAfterInspectBrowserDriver(controller);
    const adapter = createWechatImagePostAdapter(browser);

    await expect(adapter.prepareEditor(POST, { signal: controller.signal })).resolves.toEqual({
      destination: 'wechat-image',
      status: 'cancelled',
      reason: 'cancelled',
      message: '已停止填写微信贴图编辑器。',
    });
    expect(browser.operations).toEqual(['open:wechat-image', 'inspect']);
  });

  test('requires inspection when cancellation happens after upload begins', async () => {
    const controller = new AbortController();
    const adapter = createWechatImagePostAdapter(
      new AbortingAfterUploadBrowserDriver(controller),
    );

    await expect(adapter.prepareEditor(POST, { signal: controller.signal })).resolves.toEqual({
      destination: 'wechat-image',
      status: 'attention-required',
      reason: 'uncertain-result',
      message: '微信贴图填写过程中断，后台可能已有部分内容。Ailu 不会自动重传，请先检查保留的页面。',
    });
  });

  test('requires review when a newly filled editor cannot be verified', async () => {
    const browser = new RecordingBrowserDriver('empty', 'indeterminate');
    const adapter = createXiaohongshuImagePostAdapter(browser);

    await expect(adapter.prepareEditor(POST)).resolves.toEqual({
      destination: 'rednote',
      status: 'attention-required',
      reason: 'uncertain-result',
      message: '小红书内容已填写，但自动核对没有得到确定结果。请在保留的页面中人工检查。',
    });
  });
});

describe('ImagePostHandoffCoordinator', () => {
  test('retries only the destination that still needs attention', async () => {
    const xiaohongshuBrowser = new RecordingBrowserDriver();
    const wechatBrowser = new RecordingBrowserDriver('login-required');
    const coordinator = new ImagePostHandoffCoordinator([
      createXiaohongshuImagePostAdapter(xiaohongshuBrowser),
      createWechatImagePostAdapter(wechatBrowser),
    ]);

    const first = await coordinator.handoff(POST, ['rednote', 'wechat-image']);
    expect(first.outcomes).toMatchObject({
      rednote: { status: 'editor-filled' },
      'wechat-image': { status: 'attention-required', reason: 'login-required' },
    });

    wechatBrowser.setState('empty');
    const second = await coordinator.handoff(POST, ['rednote', 'wechat-image']);
    expect(second.outcomes).toMatchObject({
      rednote: { status: 'editor-filled' },
      'wechat-image': { status: 'editor-filled' },
    });
    expect(xiaohongshuBrowser.operations.filter(operation => operation.startsWith('open:'))).toEqual([
      'open:rednote',
    ]);
    expect(wechatBrowser.operations.filter(operation => operation.startsWith('open:'))).toEqual([
      'open:wechat-image',
      'open:wechat-image',
    ]);
  });

  test('coalesces repeated clicks while the same destination is still running', async () => {
    const browser = new BlockingBrowserDriver();
    const coordinator = new ImagePostHandoffCoordinator([
      createXiaohongshuImagePostAdapter(browser),
    ]);

    const first = coordinator.handoff(POST, ['rednote']);
    await Promise.resolve();
    const second = coordinator.handoff(POST, ['rednote']);
    browser.release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(browser.operations.filter(operation => operation.startsWith('open:'))).toEqual([
      'open:rednote',
    ]);
  });
});
