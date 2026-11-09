// apps/api/src/runtime/process-group.ts
// Signal a whole process group: a child spawned `detached` leads its own group, so the negative
// pid reaches everything it started (an omp child's MCP servers and workers, a preview's dev
// server) and not just the leader. Falls back to the pid alone when it leads no group — a group
// whose leader already exited is still signalled through the group id, which is its pid.
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
}
