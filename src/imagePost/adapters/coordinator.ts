import type {
  ImagePostAdapterInput,
  ImagePostAdapterOutcome,
  ImagePostDestination,
  ImagePostDestinationAdapter,
  PrepareImagePostEditorOptions,
} from './types';

export interface ImagePostHandoffSnapshot {
  readonly preparedId: string;
  readonly outcomes: Readonly<Partial<Record<ImagePostDestination, ImagePostAdapterOutcome>>>;
}

export class ImagePostHandoffCoordinator {
  private readonly adapters = new Map<ImagePostDestination, ImagePostDestinationAdapter>();
  private readonly outcomes = new Map<
    string,
    Partial<Record<ImagePostDestination, ImagePostAdapterOutcome>>
  >();
  private readonly inFlight = new Map<
    string,
    Partial<Record<ImagePostDestination, Promise<ImagePostAdapterOutcome>>>
  >();

  constructor(adapters: readonly ImagePostDestinationAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.destination)) {
        throw new Error(`Duplicate image post adapter: ${adapter.destination}`);
      }
      this.adapters.set(adapter.destination, adapter);
    }
  }

  async handoff(
    post: ImagePostAdapterInput,
    destinations: readonly ImagePostDestination[],
    options: PrepareImagePostEditorOptions = {},
  ): Promise<ImagePostHandoffSnapshot> {
    const outcomes = this.outcomes.get(post.preparedId) ?? {};
    this.outcomes.set(post.preparedId, outcomes);
    await Promise.all([...new Set(destinations)].map(async destination => {
      if (outcomes[destination]?.status === 'editor-filled') return;
      const adapter = this.adapters.get(destination);
      if (!adapter) throw new Error(`Missing image post adapter: ${destination}`);
      const active = this.inFlight.get(post.preparedId) ?? {};
      this.inFlight.set(post.preparedId, active);
      let operation = active[destination];
      if (!operation) {
        operation = adapter.prepareEditor(post, options).then(outcome => {
          outcomes[destination] = outcome;
          return outcome;
        }).finally(() => {
          if (active[destination] === operation) delete active[destination];
          if (Object.keys(active).length === 0) this.inFlight.delete(post.preparedId);
        });
        active[destination] = operation;
      }
      await operation;
    }));
    return this.snapshot(post.preparedId) ?? { preparedId: post.preparedId, outcomes: {} };
  }

  snapshot(preparedId: string): ImagePostHandoffSnapshot | null {
    const outcomes = this.outcomes.get(preparedId);
    if (!outcomes) return null;
    return { preparedId, outcomes: { ...outcomes } };
  }
}
