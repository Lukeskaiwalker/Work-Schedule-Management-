import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * A React.lazy component that can be asked for again after its import failed.
 *
 * React.lazy remembers a rejected import for good, so a lazy component made
 * once at module level stays broken after one failed chunk download until
 * the app reloads, and a retry button could only fail again. The getter
 * returned here hands out one lazy component while its import is pending or
 * done, and forgets it when the import fails, so the next call — the render
 * a retry causes — downloads the chunk again. (widgetRegistry.ts does the
 * same per widget id.)
 */
export function retryableLazy<P>(
  load: () => Promise<{ default: ComponentType<P> }>,
): () => LazyExoticComponent<ComponentType<P>> {
  let current: LazyExoticComponent<ComponentType<P>> | null = null;
  return () => {
    if (current) return current;
    const component = lazy(() =>
      load().catch((error: unknown) => {
        if (current === component) current = null;
        throw error;
      }),
    );
    current = component;
    return component;
  };
}
