/** Minimal token-bucket rate limiter. Serializes outbound Census requests. */
export function createLimiter(rps: number) {
  let chain: Promise<unknown> = Promise.resolve();
  const gap = 1000 / Math.max(rps, 0.1);
  let last = 0;

  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = Math.max(0, last + gap - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
}
