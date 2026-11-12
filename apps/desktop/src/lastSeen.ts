import { useCallback, useState, type SetStateAction } from 'react';

// The last answer each part of the app loaded, kept while the app is open, so
// coming back to a page shows what it showed before at once and refreshes
// quietly, instead of popping in from empty or a skeleton every time.
const seen = new Map<string, unknown>();

export const peek = <T>(key: string): T | undefined => seen.get(key) as T | undefined;
export const remember = <T>(key: string, value: T): T => (seen.set(key, value), value);

// useState that starts from the last value under `key` and remembers every change.
export function useLastSeen<T>(key: string, empty: T): [T, (v: SetStateAction<T>) => void] {
  const [value, setValue] = useState<T>(() => (seen.has(key) ? (seen.get(key) as T) : empty));
  const set = useCallback(
    (v: SetStateAction<T>) =>
      setValue(prev => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        seen.set(key, next);
        return next;
      }),
    [key],
  );
  return [value, set];
}
