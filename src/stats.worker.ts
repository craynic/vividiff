/// <reference lib="webworker" />
import { fileLineStats } from './diff';
import type { ChangedFile, LineStats } from './types';
self.onmessage = (event: MessageEvent<ChangedFile[]>) => {
  const started = performance.now();
  let batch: Record<string, LineStats | null> = Object.create(null);
  event.data.forEach((file, index) => {
    batch[file.path] = performance.now() - started < 15000 ? fileLineStats(file) : null;
    if ((index + 1) % 20 === 0 || index === event.data.length - 1) {
      self.postMessage(batch);
      batch = Object.create(null);
    }
  });
};
