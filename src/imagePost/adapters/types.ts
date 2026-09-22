export type ImagePostDestination = 'rednote' | 'wechat-image';

export interface ImagePostInputImage {
  readonly id: string;
  readonly path: string;
}

export interface ImagePostAdapterInput {
  readonly preparedId: string;
  readonly title: string;
  readonly body: string;
  readonly topics: readonly string[];
  readonly images: readonly ImagePostInputImage[];
}

export type ImagePostComposerState =
  | 'empty'
  | 'content-present'
  | 'login-required'
  | 'captcha-required'
  | 'page-changed';

export type ImagePostVerification = 'matched' | 'mismatched' | 'indeterminate';

export type ImagePostAttentionReason =
  | 'login-required'
  | 'captcha-required'
  | 'page-changed'
  | 'uncertain-result';

export type ImagePostAdapterOutcome =
  | {
    readonly destination: ImagePostDestination;
    readonly status: 'editor-filled';
    readonly reason: null;
    readonly message: string;
  }
  | {
    readonly destination: ImagePostDestination;
    readonly status: 'attention-required';
    readonly reason: ImagePostAttentionReason;
    readonly message: string;
  }
  | {
    readonly destination: ImagePostDestination;
    readonly status: 'failed';
    readonly reason: 'browser-failure';
    readonly message: string;
  }
  | {
    readonly destination: ImagePostDestination;
    readonly status: 'cancelled';
    readonly reason: 'cancelled';
    readonly message: string;
  };

export interface ImagePostBrowserDriver {
  openEditor(destination: ImagePostDestination, signal: AbortSignal, onStage?: (stage: ImagePostOpeningStage) => void): Promise<void>;
  inspectEditor(signal: AbortSignal, onStage?: (stage: ImagePostOpeningStage) => void): Promise<ImagePostComposerState>;
  uploadImages(
    paths: readonly string[],
    signal: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<void>;
  fillTitle(title: string, signal: AbortSignal): Promise<void>;
  fillBody(body: string, signal: AbortSignal): Promise<void>;
  fillTopics(topics: readonly string[], signal: AbortSignal): Promise<void>;
  verifyContent(post: ImagePostAdapterInput, signal: AbortSignal): Promise<ImagePostVerification>;
}

export type ImagePostOpeningStage = 'connecting-browser' | 'waiting-home' | 'opening-editor' | 'waiting-editor';

export interface PrepareImagePostEditorOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImagePostAdapterProgress) => void;
  readonly taskTimeoutMs?: number;
}

export interface ImagePostAdapterProgress {
  readonly destination: ImagePostDestination;
  readonly stage:
    | 'opening'
    | ImagePostOpeningStage
    | 'waiting-login'
    | 'uploading'
    | 'filling-title'
    | 'filling-body'
    | 'filling-topics'
    | 'verifying'
    | 'completed';
  readonly message: string;
  readonly completedImages?: number;
  readonly totalImages?: number;
}

export interface ImagePostDestinationAdapter {
  readonly destination: ImagePostDestination;
  prepareEditor(
    post: ImagePostAdapterInput,
    options?: PrepareImagePostEditorOptions,
  ): Promise<ImagePostAdapterOutcome>;
}
