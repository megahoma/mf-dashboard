export function createSerialQueue() {
  let chain: Promise<void> = Promise.resolve();
  return function run<T>(work: () => Promise<T>): Promise<T> {
    const runPromise = chain.then(work, work);
    chain = runPromise.then(
      () => undefined,
      () => undefined,
    );
    return runPromise;
  };
}

export function createKeyedLock() {
  const chains = new Map<string, Promise<void>>();
  return function run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const runPromise = previous.then(work, work);
    chains.set(
      key,
      runPromise.then(
        () => undefined,
        () => undefined,
      ),
    );
    return runPromise;
  };
}
