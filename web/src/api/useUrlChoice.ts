import { useSearchParams } from "react-router-dom";

/**
 * A choice among `options` kept in the URL's query string (`?tab=scenes`), so a reload keeps it and
 * a link can open it directly. An absent or unknown value reads as `fallback`; choosing `fallback`
 * drops the parameter. Replaces the history entry rather than pushing one per click.
 */
export function useUrlChoice<T extends string>(key: string, options: readonly T[], fallback: T): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = raw !== null && (options as readonly string[]).includes(raw) ? (raw as T) : fallback;

  function set(next: T): void {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (next === fallback) updated.delete(key);
        else updated.set(key, next);
        return updated;
      },
      { replace: true },
    );
  }

  return [value, set];
}
