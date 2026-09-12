/** Une conversion partagée ne s'arrête qu'après le départ de son dernier lecteur. */
export class SharedPreparations {
  #jobs = new Map();

  run(key, signal, prepare, onProgress) {
    signal?.throwIfAborted();
    let job = this.#jobs.get(key);
    if (!job || job.controller.signal.aborted) {
      job = { controller: new AbortController(), consumers: new Map(), progress: null, finished: false, promise: null };
      const current = job;
      current.promise = Promise.resolve().then(() => prepare(current.controller.signal, (progress) => {
        current.progress = progress;
        for (const callback of current.consumers.values()) callback?.(progress);
      })).finally(() => {
        current.finished = true;
        if (this.#jobs.get(key) === current) this.#jobs.delete(key);
      });
      this.#jobs.set(key, current);
    }
    const current = job;
    return new Promise((resolve, reject) => {
      const consumer = Symbol();
      current.consumers.set(consumer, onProgress);
      const cleanup = () => { current.consumers.delete(consumer); signal?.removeEventListener("abort", abort); };
      const abort = () => {
        cleanup();
        if (!current.finished && current.consumers.size === 0) current.controller.abort();
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      current.promise.then((result) => { cleanup(); resolve(result); }, (error) => { cleanup(); reject(error); });
      if (signal?.aborted) abort();
      else if (current.progress) onProgress?.(current.progress);
    });
  }
}
