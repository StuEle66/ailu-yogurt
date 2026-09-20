import type {
  ImagePostAdapterInput,
  ImagePostBrowserDriver,
  ImagePostComposerState,
  ImagePostDestination,
  ImagePostVerification,
} from './types';

/** Keeps the reusable workspace functional until a platform driver is installed. */
export class UnavailableImagePostBrowserDriver implements ImagePostBrowserDriver {
  constructor(private readonly reason: string) {}
  openEditor(_destination: ImagePostDestination, _signal: AbortSignal): Promise<void> { return this.fail(); }
  inspectEditor(_signal: AbortSignal): Promise<ImagePostComposerState> { return this.fail(); }
  uploadImages(_paths: readonly string[], _signal: AbortSignal): Promise<void> { return this.fail(); }
  fillTitle(_title: string, _signal: AbortSignal): Promise<void> { return this.fail(); }
  fillBody(_body: string, _signal: AbortSignal): Promise<void> { return this.fail(); }
  fillTopics(_topics: readonly string[], _signal: AbortSignal): Promise<void> { return this.fail(); }
  verifyContent(_post: ImagePostAdapterInput, _signal: AbortSignal): Promise<ImagePostVerification> { return this.fail(); }
  private fail<T>(): Promise<T> { return Promise.reject(new Error(this.reason)); }
}
