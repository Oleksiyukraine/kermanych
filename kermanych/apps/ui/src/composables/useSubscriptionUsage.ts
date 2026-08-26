import { onMounted, onUnmounted, ref, type Ref } from 'vue';
import type { SubscriptionUsage } from '@kermanych/core';
import { api } from '../lib/api';
import { useAuth } from '../stores/auth';

// The provider plan behind this machine's agents, polled while the caller is mounted. The
// api answers from a one-minute cache (apps/api/src/usage/usage.service.ts), so polling at
// the same cadence costs one `omp usage` per minute and no more.
//
// Two deliberate silences:
//   * the first read waits for `auth.ready` — the local api is guarded, and an unauthorised
//     read there signs the user out (stores/auth.ts installs that handler);
//   * a failed poll keeps the previous value instead of blanking the chip. A dropped api
//     connection is not news about the plan.
export function useSubscriptionUsage(intervalMs = 60_000): Ref<SubscriptionUsage | undefined> {
  const usage = ref<SubscriptionUsage | undefined>(undefined);
  const auth = useAuth();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  async function poll(): Promise<void> {
    try {
      const next = await api.subscriptionUsage();
      if (!stopped) usage.value = next;
    } catch {
      /* api down or restarting — keep the last known figures */
    }
  }

  onMounted(async () => {
    await auth.ready;
    if (stopped) return;
    void poll();
    timer = setInterval(() => void poll(), intervalMs);
  });

  onUnmounted(() => {
    stopped = true;
    clearInterval(timer);
  });

  return usage;
}
