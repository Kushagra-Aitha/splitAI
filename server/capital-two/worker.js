// C12 follows B12's current 20-second cadence. A tick never overlaps itself;
// database uniqueness/conditional claims coordinate separate API processes.
export function startCapitalWorker(service, { intervalMs = 20_000, onError = () => {} } = {}) {
  let stopped = false, timer, running;
  async function tick() {
    const started = Date.now();
    running = service.tick().catch(() => onError({ event: 'BANK_WORKER_RETRY' }));
    await running;
    if (!stopped) {
      timer = setTimeout(() => void tick(), Math.max(1000, intervalMs - (Date.now() - started)));
      timer.unref?.();
    }
  }
  void tick();
  return { async stop() { stopped = true; clearTimeout(timer); await running; } };
}
