function admissionError({
  code,
  status,
  provider,
  message,
  active,
  limit,
  queued,
  maxQueued,
  queuedBytes,
  maxQueuedBytes,
  queueWaitMs,
}) {
  const error = new Error(message);
  error.name = "ProviderAdmissionError";
  error.code = code;
  error.status = status;
  error.provider = provider;
  error.active = active;
  error.limit = limit;
  error.queued = queued;
  error.maxQueued = maxQueued;
  error.queuedBytes = queuedBytes;
  error.maxQueuedBytes = maxQueuedBytes;
  if (queueWaitMs !== undefined) error.queueWaitMs = queueWaitMs;
  error.retryAfterSeconds = 5;
  return error;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The request was canceled while waiting for a provider slot.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function createProviderInflightQueue({
  provider,
  maxActive,
  maxQueued = 8,
  maxQueuedBytes = 64 * 1024 * 1024,
  queueTimeoutMs = 10 * 60_000,
}) {
  if (!provider || typeof provider !== "string") {
    throw new TypeError("provider must be a non-empty string");
  }
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    throw new RangeError("maxActive must be a positive integer");
  }
  if (!Number.isInteger(maxQueued) || maxQueued < 0) {
    throw new RangeError("maxQueued must be a non-negative integer");
  }
  if (!Number.isInteger(maxQueuedBytes) || maxQueuedBytes < 0) {
    throw new RangeError("maxQueuedBytes must be a non-negative integer");
  }
  if (!Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1) {
    throw new RangeError("queueTimeoutMs must be a positive integer");
  }

  let active = 0;
  let queuedBytes = 0;
  const waiting = [];

  function releaseFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      drain();
    };
  }

  function cleanup(entry) {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener?.("abort", entry.onAbort);
  }

  function remove(entry) {
    const index = waiting.indexOf(entry);
    if (index < 0) return false;
    const [removed] = waiting.splice(index, 1);
    queuedBytes = Math.max(0, queuedBytes - removed.weightBytes);
    cleanup(removed);
    return true;
  }

  function nextEligibleIndex() {
    if (active >= maxActive) return -1;
    return waiting.length ? 0 : -1;
  }

  function drain() {
    for (;;) {
      const index = nextEligibleIndex();
      if (index < 0) return;
      const [entry] = waiting.splice(index, 1);
      queuedBytes = Math.max(0, queuedBytes - entry.weightBytes);
      cleanup(entry);
      if (entry.signal?.aborted) {
        entry.reject(abortError(entry.signal));
        continue;
      }
      active += 1;
      entry.resolve(releaseFactory());
    }
  }

  function acquire({ priority = false, signal, weightBytes = 0 } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const requestWeight = Number.isFinite(weightBytes) && weightBytes > 0
      ? Math.ceil(weightBytes)
      : 0;

    // Priority compaction can jump ordinary waiters, but never exceeds the
    // provider's proven active-request limit.
    if (!waiting.length && active < maxActive) {
      active += 1;
      return Promise.resolve(releaseFactory());
    }
    if (
      waiting.length >= maxQueued ||
      queuedBytes + requestWeight > maxQueuedBytes
    ) {
      return Promise.reject(admissionError({
        code: "ERR_PROVIDER_QUEUE_FULL",
        status: 503,
        provider,
        message: `The ${provider} request queue is full (${waiting.length}/${maxQueued} waiting).`,
        active,
        limit: maxActive,
        queued: waiting.length,
        maxQueued,
        queuedBytes,
        maxQueuedBytes,
      }));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        priority,
        signal,
        resolve,
        reject,
        onAbort: undefined,
        timer: undefined,
        enqueuedAt: Date.now(),
        weightBytes: requestWeight,
      };
      entry.onAbort = () => {
        if (!remove(entry)) return;
        reject(abortError(signal));
        drain();
      };

      if (priority) {
        const firstOrdinary = waiting.findIndex((item) => !item.priority);
        if (firstOrdinary < 0) waiting.push(entry);
        else waiting.splice(firstOrdinary, 0, entry);
      } else {
        waiting.push(entry);
      }
      queuedBytes += entry.weightBytes;

      entry.timer = setTimeout(() => {
        if (!remove(entry)) return;
        reject(admissionError({
          code: "ERR_PROVIDER_QUEUE_TIMEOUT",
          status: 504,
          provider,
          message: `The ${provider} request timed out while waiting for a provider slot.`,
          active,
          limit: maxActive,
          queued: waiting.length,
          maxQueued,
          queuedBytes,
          maxQueuedBytes,
          queueWaitMs: Date.now() - entry.enqueuedAt,
        }));
        drain();
      }, queueTimeoutMs);
      signal?.addEventListener?.("abort", entry.onAbort, { once: true });
      drain();
    });
  }

  return {
    acquire,
    snapshot() {
      return {
        active,
        queued: waiting.length,
        queuedBytes,
        maxActive,
        maxQueued,
        maxQueuedBytes,
        queueTimeoutMs,
      };
    },
  };
}
