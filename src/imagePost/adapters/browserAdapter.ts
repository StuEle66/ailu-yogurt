import type {
  ImagePostAdapterInput,
  ImagePostAdapterOutcome,
  ImagePostBrowserDriver,
  ImagePostDestination,
  ImagePostDestinationAdapter,
  PrepareImagePostEditorOptions,
} from './types';
import { userFacingErrorMessage } from '../../utils/userFacingError';

export class BrowserImagePostDestinationAdapter implements ImagePostDestinationAdapter {
  constructor(
    readonly destination: ImagePostDestination,
    private readonly driver: ImagePostBrowserDriver,
  ) {}

  async prepareEditor(
    post: ImagePostAdapterInput,
    options: PrepareImagePostEditorOptions = {},
  ): Promise<ImagePostAdapterOutcome> {
    const operation = boundedOperationSignal(options.signal, options.taskTimeoutMs ?? 120_000);
    const signal = operation.signal;
    let mutationStarted = false;
    try {
      if (signal.aborted) return this.cancelledOutcome();
      this.progress(options, 'opening', `正在打开${this.destinationName()}后台…`);
      await this.driver.openEditor(this.destination, signal);
      if (signal.aborted) return this.cancelledOutcome();
      const state = await this.driver.inspectEditor(signal);
      if (signal.aborted) return this.cancelledOutcome();
      if (state === 'login-required') {
        this.progress(options, 'waiting-login', `等待登录${this.destinationName()}…`);
        return {
          destination: this.destination,
          status: 'attention-required',
          reason: 'login-required',
          message: `${this.destinationName()}登录已失效，请在保留的浏览器窗口中重新登录。`,
        };
      }
      if (state === 'captcha-required') {
        this.progress(options, 'waiting-login', `等待完成${this.destinationName()}验证…`);
        return {
          destination: this.destination,
          status: 'attention-required',
          reason: 'captcha-required',
          message: `${this.destinationName()}需要完成验证码，请在保留的浏览器窗口中处理。`,
        };
      }
      if (state === 'page-changed') {
        return {
          destination: this.destination,
          status: 'attention-required',
          reason: 'page-changed',
          message: `${this.destinationName()}后台页面结构已变化，Ailu 已停止填写，请检查页面。`,
        };
      }
      if (state === 'content-present') {
        this.progress(options, 'verifying', `正在核对${this.destinationName()}已有内容…`);
        const verification = await this.driver.verifyContent(post, signal);
        if (verification === 'matched') {
          this.progress(options, 'completed', `${this.destinationName()}内容核对完成。`);
          return this.filledOutcome();
        }
        return {
          destination: this.destination,
          status: 'attention-required',
          reason: 'uncertain-result',
          message: `${this.destinationName()}编辑器已有内容，但无法确认与本次内容一致。Ailu 未重复上传，请人工核对。`,
        };
      }
      mutationStarted = true;
      this.progress(options, 'uploading', `正在上传图片到${this.destinationName()}…`);
      await this.driver.uploadImages(post.images.map(image => image.path), signal);
      this.throwIfAborted(signal);
      this.progress(options, 'filling-title', `正在填写${this.destinationName()}标题…`);
      await this.driver.fillTitle(post.title, signal);
      this.throwIfAborted(signal);
      this.progress(options, 'filling-body', `正在填写${this.destinationName()}文案…`);
      await this.driver.fillBody(post.body, signal);
      this.throwIfAborted(signal);
      this.progress(options, 'filling-topics', `正在填写${this.destinationName()}话题…`);
      await this.driver.fillTopics(post.topics, signal);
      this.throwIfAborted(signal);
      this.progress(options, 'verifying', `正在核对${this.destinationName()}内容…`);
      const verification = await this.driver.verifyContent(post, signal);
      if (verification !== 'matched') {
        return {
          destination: this.destination,
          status: 'attention-required',
          reason: 'uncertain-result',
          message: `${this.destinationName()}内容已填写，但自动核对没有得到确定结果。请在保留的页面中人工检查。`,
        };
      }

      this.progress(options, 'completed', `${this.destinationName()}内容核对完成。`);
      return this.filledOutcome();
    } catch (error) {
      if (mutationStarted) {
        return {
          destination: this.destination,
          status: 'attention-required',
          reason: 'uncertain-result',
          message: `${this.destinationName()}填写过程中断，后台可能已有部分内容。Ailu 不会自动重传，请先检查保留的页面。`,
        };
      }
      if (operation.didTimeout()) {
        return {
          destination: this.destination,
          status: 'failed',
          reason: 'browser-failure',
          message: `${this.destinationName()}后台填写超时，尚未上传图片，可以安全重试。`,
        };
      }
      if (signal.aborted) return this.cancelledOutcome();
      return {
        destination: this.destination,
        status: 'failed',
        reason: 'browser-failure',
        message: userFacingErrorMessage(
          error,
          `${this.destinationName()}浏览器操作失败，请查看本地诊断日志。`,
        ),
      };
    } finally {
      operation.dispose();
    }
  }

  private filledOutcome(): ImagePostAdapterOutcome {
    return {
      destination: this.destination,
      status: 'editor-filled',
      reason: null,
      message: `内容已填入${this.destinationName()}编辑器，请检查后手动发布。`,
    };
  }

  private cancelledOutcome(): ImagePostAdapterOutcome {
    return {
      destination: this.destination,
      status: 'cancelled',
      reason: 'cancelled',
      message: `已停止填写${this.destinationName()}编辑器。`,
    };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Image post editor operation was cancelled.');
  }

  private progress(
    options: PrepareImagePostEditorOptions,
    stage: Parameters<NonNullable<PrepareImagePostEditorOptions['onProgress']>>[0]['stage'],
    message: string,
  ): void {
    options.onProgress?.({ destination: this.destination, stage, message });
  }

  private destinationName(): string {
    return this.destination === 'rednote' ? '小红书' : '微信贴图';
  }
}

function boundedOperationSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('图文后台填写超时。', 'TimeoutError'));
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}
