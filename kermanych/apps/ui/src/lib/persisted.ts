// apps/ui/src/lib/persisted.ts
import { ref, watch, type Ref } from 'vue';

// A device-local screen preference, like the locale (lib/locale.ts): localStorage, never Supabase.
// Every read and write is guarded — a refused storage (private mode, quota, vitest's node env) only
// means the choice lasts until the app restarts. `parse` returns null for a value it does not
// recognise, which reads as the fallback.
export function persisted<T>(key: string, fallback: T, parse: (raw: string) => T | null, write: (v: T) => string): Ref<T> {
  let initial = fallback;
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    initial = (raw === null ? null : parse(raw)) ?? fallback;
  } catch {
    // unreadable storage: the fallback
  }
  const r = ref(initial) as Ref<T>;
  watch(r, (v) => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, write(v));
    } catch {
      // storage refused: kept in memory only
    }
  });
  return r;
}
