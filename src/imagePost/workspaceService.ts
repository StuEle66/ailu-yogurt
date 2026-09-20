import type {
  ImagePostAdapterInput,
  ImagePostDestination as AdapterDestination,
  ImagePostHandoffSnapshot,
} from './adapters';
import type { ImagePostDestination, PreparedImagePost } from './index';

export interface ImagePostHandoffCoordinatorLike {
  handoff(
    post: ImagePostAdapterInput,
    destinations: readonly AdapterDestination[],
  ): Promise<ImagePostHandoffSnapshot>;
}

export async function handoffPreparedImagePost(
  prepared: PreparedImagePost,
  coordinator: ImagePostHandoffCoordinatorLike,
): Promise<Readonly<Partial<Record<ImagePostDestination, ImagePostHandoffSnapshot>>>> {
  const results: Partial<Record<ImagePostDestination, ImagePostHandoffSnapshot>> = {};
  for (const destination of prepared.destinations) {
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
    results[destination] = await coordinator.handoff(input, [destination]);
  }
  return Object.freeze(results);
}
