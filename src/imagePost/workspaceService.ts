import type {
  ImagePostAdapterProgress,
  ImagePostAdapterInput,
  ImagePostDestination as AdapterDestination,
  ImagePostHandoffSnapshot,
} from './adapters';
import type { ImagePostDestination, PreparedImagePost } from './index';

export type ImagePostHandoffProgress = ImagePostAdapterProgress;

export interface ImagePostHandoffOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImagePostHandoffProgress) => void;
}

export interface ImagePostHandoffCoordinatorLike {
  handoff(
    post: ImagePostAdapterInput,
    destinations: readonly AdapterDestination[],
    options?: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: ImagePostHandoffProgress) => void;
    },
  ): Promise<ImagePostHandoffSnapshot>;
}

export async function handoffPreparedImagePost(
  prepared: PreparedImagePost,
  coordinator: ImagePostHandoffCoordinatorLike,
  options: ImagePostHandoffOptions = {},
): Promise<Readonly<Partial<Record<ImagePostDestination, ImagePostHandoffSnapshot>>>> {
  const results: Partial<Record<ImagePostDestination, ImagePostHandoffSnapshot>> = {};
  await Promise.all(prepared.destinations.map(async destination => {
    const copy = prepared.copyByDestination[destination];
    if (!copy) throw new Error(`图文目标“${destination}”缺少冻结文案。`);
    const input: ImagePostAdapterInput = {
      preparedId: prepared.contentHash,
      title: copy.title,
      body: copy.body,
      topics: copy.topics,
      images: prepared.materials.map(material => ({
        id: material.id,
        path: material.managedPath,
      })),
    };
    try {
      results[destination] = await coordinator.handoff(input, [destination], {
        signal: options.signal,
        onProgress: options.onProgress,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      results[destination] = {
        preparedId: prepared.contentHash,
        outcomes: {
          [destination]: {
            destination,
            status: 'failed',
            reason: 'browser-failure',
            message: `${destination === 'rednote' ? '小红书' : '微信贴图'}后台填写失败：${detail}`,
          },
        },
      };
    }
  }));
  return Object.freeze(results);
}
