import { onMounted, onUnmounted, ref, type Ref } from 'vue';

// A shared "current time" ticker for relative timestamps. Returns a ref of
// Date.now() refreshed every `intervalMs` while mounted; the interval is
// cleared on unmount so it never leaks.
export function useNow(intervalMs = 15_000): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    now.value = Date.now();
    timer = setInterval(() => (now.value = Date.now()), intervalMs);
  });
  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });
  return now;
}
