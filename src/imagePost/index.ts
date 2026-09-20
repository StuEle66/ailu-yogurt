import { createHash } from 'node:crypto';

export interface ImagePostSource {
  articlePath: string;
  contentVersion: string;
}

export interface ImagePostMaterialBase {
  id: string;
  fileName: string;
  contentHash: string;
  width: number;
  height: number;
  managedPath: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface ImagePostCardMaterial extends ImagePostMaterialBase {
  kind: 'card';
  renderedPage: number;
}

export interface ImagePostPhotoMaterial extends ImagePostMaterialBase {
  kind: 'photo';
  originalName: string;
}

export {
  ManagedImagePostAssetStore,
  type ImportImagePostPhotoInput,
  type ImportRenderedImagePostCardInput,
  type ManagedAssetFileSystem,
} from './managedAssetStore';
export {
  ImagePostDraftStore,
  type ImagePostDraftFileSystem,
} from './draftStore';

export type ImagePostMaterial = ImagePostCardMaterial | ImagePostPhotoMaterial;

export type ImagePostDestination = 'rednote' | 'wechat-image';

export interface ImagePostCopy {
  title: string;
  body: string;
  topics: string[];
}

export interface PreparedImagePostCopy {
  readonly title: string;
  readonly body: string;
  readonly topics: readonly string[];
}

export interface ImagePostDraft {
  id: string;
  source: ImagePostSource | null;
  materials: ImagePostMaterial[];
  leadMaterialId: string | null;
  sharedCopy: ImagePostCopy;
  destinationCopy: Partial<Record<ImagePostDestination, ImagePostCopy>>;
}

export interface PreparedImagePost {
  schemaVersion: 1;
  draftId: string;
  source: Readonly<ImagePostSource> | null;
  contentHash: string;
  destinations: readonly ImagePostDestination[];
  materials: readonly Readonly<ImagePostMaterial>[];
  leadMaterialId: string;
  copyByDestination: Readonly<Partial<Record<ImagePostDestination, PreparedImagePostCopy>>>;
}

export type ImagePostDestinationStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'uncertain'
  | 'cancelled';

export interface ImagePostDestinationState {
  status: ImagePostDestinationStatus;
  message: string;
  reviewUrl: string | null;
}

export interface ImagePostDeliveryState {
  preparedContentHash: string;
  destinations: Readonly<Record<ImagePostDestination, ImagePostDestinationState | null>>;
}

export interface ImagePostDestinationOutcome {
  status: 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
  message: string;
  reviewUrl?: string | null;
}

export function createImagePostDraft(input: {
  id: string;
  source: ImagePostSource | null;
}): ImagePostDraft {
  return {
    ...input,
    materials: [],
    leadMaterialId: null,
    sharedCopy: { title: '', body: '', topics: [] },
    destinationCopy: {},
  };
}

export function updateSharedImagePostCopy(
  draft: ImagePostDraft,
  copy: ImagePostCopy,
): ImagePostDraft {
  return { ...draft, sharedCopy: cloneCopy(copy) };
}

export function setDestinationImagePostCopy(
  draft: ImagePostDraft,
  destination: ImagePostDestination,
  copy: ImagePostCopy,
): ImagePostDraft {
  return {
    ...draft,
    destinationCopy: {
      ...draft.destinationCopy,
      [destination]: cloneCopy(copy),
    },
  };
}

export function resetDestinationImagePostCopy(
  draft: ImagePostDraft,
  destination: ImagePostDestination,
): ImagePostDraft {
  const destinationCopy = { ...draft.destinationCopy };
  delete destinationCopy[destination];
  return { ...draft, destinationCopy };
}

export function resolveImagePostCopy(
  draft: ImagePostDraft,
  destination: ImagePostDestination,
): ImagePostCopy {
  return cloneCopy(draft.destinationCopy[destination] ?? draft.sharedCopy);
}

function cloneCopy(copy: ImagePostCopy): ImagePostCopy {
  return { ...copy, topics: [...copy.topics] };
}

export function prepareImagePost(
  draft: ImagePostDraft,
  requestedDestinations: readonly ImagePostDestination[],
): PreparedImagePost {
  const destinations = [...new Set(requestedDestinations)];
  if (!destinations.length) throw new Error('请至少选择一个图文发送目标。');
  if (!draft.materials.length || !draft.leadMaterialId) {
    throw new Error('图文发送前至少需要一张图片。');
  }
  if (!draft.materials.some(material => material.id === draft.leadMaterialId)) {
    throw new Error('图文首图已失效，请重新选择。');
  }
  const source = draft.source ? Object.freeze({ ...draft.source }) : null;
  const materials = Object.freeze(draft.materials.map(material => {
    if (!/^[a-f0-9]{64}$/u.test(material.contentHash)) {
      throw new Error(`图文素材“${material.fileName}”缺少有效内容哈希。`);
    }
    if (!material.managedPath || material.managedPath.startsWith('blob:')) {
      throw new Error(`图文素材“${material.fileName}”尚未写入受管路径。`);
    }
    return Object.freeze({ ...material });
  }));
  const copyByDestination: Partial<Record<ImagePostDestination, PreparedImagePostCopy>> = {};
  for (const destination of destinations) {
    const copy = resolveImagePostCopy(draft, destination);
    copyByDestination[destination] = Object.freeze({
      ...copy,
      topics: Object.freeze([...copy.topics]),
    });
  }
  Object.freeze(copyByDestination);
  const frozenDestinations = Object.freeze(destinations);
  const hashPayload = {
    schemaVersion: 1,
    draftId: draft.id,
    source,
    destinations: frozenDestinations,
    materials,
    leadMaterialId: draft.leadMaterialId,
    copyByDestination,
  };
  const contentHash = createHash('sha256')
    .update(JSON.stringify(hashPayload), 'utf8')
    .digest('hex');
  return Object.freeze({ ...hashPayload, contentHash }) as PreparedImagePost;
}

export function createImagePostDeliveryState(
  prepared: PreparedImagePost,
): ImagePostDeliveryState {
  const selected = new Set(prepared.destinations);
  return freezeDeliveryState({
    preparedContentHash: prepared.contentHash,
    destinations: {
      rednote: selected.has('rednote') ? pendingDestinationState() : null,
      'wechat-image': selected.has('wechat-image') ? pendingDestinationState() : null,
    },
  });
}

export function startImagePostDestination(
  state: ImagePostDeliveryState,
  destination: ImagePostDestination,
  message = '',
): ImagePostDeliveryState {
  const current = requireSelectedDestination(state, destination);
  if (current.status !== 'pending') {
    throw new Error(`图文目标“${destination}”当前不能开始，状态为 ${current.status}。`);
  }
  return updateDestinationState(state, destination, {
    status: 'running', message, reviewUrl: null,
  });
}

export function settleImagePostDestination(
  state: ImagePostDeliveryState,
  destination: ImagePostDestination,
  outcome: ImagePostDestinationOutcome,
): ImagePostDeliveryState {
  const current = requireSelectedDestination(state, destination);
  if (current.status !== 'running') {
    throw new Error(`图文目标“${destination}”没有正在运行的任务。`);
  }
  return updateDestinationState(state, destination, {
    status: outcome.status,
    message: outcome.message,
    reviewUrl: outcome.reviewUrl ?? null,
  });
}

export function retryFailedImagePostDestinations(
  state: ImagePostDeliveryState,
): { state: ImagePostDeliveryState; destinations: ImagePostDestination[] } {
  const destinations: ImagePostDestination[] = [];
  let next = state;
  for (const destination of ['rednote', 'wechat-image'] as const) {
    if (state.destinations[destination]?.status !== 'failed') continue;
    destinations.push(destination);
    next = updateDestinationState(next, destination, pendingDestinationState());
  }
  return { state: next, destinations };
}

function pendingDestinationState(): ImagePostDestinationState {
  return { status: 'pending', message: '', reviewUrl: null };
}

function requireSelectedDestination(
  state: ImagePostDeliveryState,
  destination: ImagePostDestination,
): ImagePostDestinationState {
  const current = state.destinations[destination];
  if (!current) throw new Error(`图文目标“${destination}”不在本次发送范围内。`);
  return current;
}

function updateDestinationState(
  state: ImagePostDeliveryState,
  destination: ImagePostDestination,
  destinationState: ImagePostDestinationState,
): ImagePostDeliveryState {
  return freezeDeliveryState({
    preparedContentHash: state.preparedContentHash,
    destinations: { ...state.destinations, [destination]: destinationState },
  });
}

function freezeDeliveryState(state: ImagePostDeliveryState): ImagePostDeliveryState {
  const destinations = Object.freeze({
    rednote: state.destinations.rednote
      ? Object.freeze({ ...state.destinations.rednote })
      : null,
    'wechat-image': state.destinations['wechat-image']
      ? Object.freeze({ ...state.destinations['wechat-image'] })
      : null,
  });
  return Object.freeze({ ...state, destinations });
}

export function addImagePostMaterial(
  draft: ImagePostDraft,
  material: ImagePostMaterial,
): ImagePostDraft {
  if (draft.materials.some(existing => existing.id === material.id)) {
    throw new Error(`图文素材 ID 重复：${material.id}`);
  }
  return {
    ...draft,
    materials: [...draft.materials, { ...material }],
    leadMaterialId: draft.leadMaterialId ?? material.id,
  };
}

export function moveImagePostMaterial(
  draft: ImagePostDraft,
  materialId: string,
  index: number,
): ImagePostDraft {
  const currentIndex = draft.materials.findIndex(material => material.id === materialId);
  if (currentIndex < 0) throw new Error(`找不到图文素材：${materialId}`);
  const materials = [...draft.materials];
  const [material] = materials.splice(currentIndex, 1);
  const targetIndex = Math.max(0, Math.min(Math.trunc(index), materials.length));
  materials.splice(targetIndex, 0, material);
  return { ...draft, materials };
}

export function removeImagePostMaterial(
  draft: ImagePostDraft,
  materialId: string,
): ImagePostDraft {
  const materials = draft.materials.filter(material => material.id !== materialId);
  if (materials.length === draft.materials.length) return draft;
  return {
    ...draft,
    materials,
    leadMaterialId: draft.leadMaterialId === materialId
      ? materials[0]?.id ?? null
      : draft.leadMaterialId,
  };
}

export function setImagePostLeadMaterial(
  draft: ImagePostDraft,
  materialId: string,
): ImagePostDraft {
  if (!draft.materials.some(material => material.id === materialId)) {
    throw new Error(`找不到图文素材：${materialId}`);
  }
  return { ...draft, leadMaterialId: materialId };
}

export * from './adapters';
