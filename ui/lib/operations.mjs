import crypto from 'node:crypto';

const ACTIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['succeeded', 'failed']);

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error || 'operation failed');
  return message.replace(/[\r\n\t]+/g, ' ')
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g, '[local path]')
    .replace(/(?:\/[A-Za-z0-9._ -]+){2,}/g, '[local path]')
    .replace(/\s{2,}/g, ' ').trim().slice(0, 500) || 'operation failed';
}

function clone(record) {
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

export class OperationConflictError extends Error {
  constructor(type, operation) {
    super(`a ${type} operation is already running`);
    this.name = 'OperationConflictError';
    this.code = 'OPERATION_ACTIVE';
    this.operation = operation;
  }
}

export class OperationManager {
  constructor({ now = () => new Date(), id = () => crypto.randomUUID() } = {}) {
    this.now = now;
    this.id = id;
    this.records = new Map();
    this.executions = new Map();
    this.accepting = true;
  }

  get(operationId) { return clone(this.records.get(operationId)); }

  latest(type) {
    return clone([...this.records.values()].filter((record) => !type || record.type === type).at(-1));
  }

  list(type) {
    return [...this.records.values()].filter((record) => !type || record.type === type).map(clone);
  }

  active(type) {
    return clone([...this.records.values()].findLast((record) => (!type || record.type === type) && ACTIVE.has(record.status)));
  }

  activeList() { return [...this.records.values()].filter((record) => ACTIVE.has(record.status)).map(clone); }

  resumeAdmission() {
    if (this.executions.size) throw new Error('cannot resume operation admission while work is active');
    this.accepting = true;
  }

  async shutdown({ timeoutMs = 10_000 } = {}) {
    this.accepting = false;
    const active = [...this.executions.values()];
    for (const execution of active) execution.controller.abort(new Error('operation cancelled for shutdown'));
    if (!active.length) return;
    const settled = Promise.allSettled(active.map(({ finished }) => finished));
    if (timeoutMs === null) {
      await settled;
      return;
    }
    let timer;
    try {
      await Promise.race([
        settled,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('active operations did not close before shutdown')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  start(type, executor, { phase = 'Queued', total = 1, estimate = null } = {}) {
    if (!this.accepting) throw new Error('operation manager is shutting down');
    const active = this.active(type);
    if (active) throw new OperationConflictError(type, active);
    const timestamp = this.now().toISOString();
    const record = {
      id: this.id(), type, status: 'queued', phase,
      progress: { current: 0, total: Math.max(1, Number(total) || 1) },
      estimate: estimate ? clone(estimate) : null,
      startedAt: timestamp, updatedAt: timestamp, finishedAt: null,
      result: null, error: null,
    };
    this.records.set(record.id, record);
    const controller = new AbortController();
    let settle;
    const finished = new Promise((resolve) => { settle = resolve; });
    this.executions.set(record.id, { controller, finished });

    setImmediate(async () => {
      record.status = 'running';
      record.updatedAt = this.now().toISOString();
      const update = ({ phase: nextPhase, current, total: nextTotal, estimate: nextEstimate } = {}) => {
        if (nextPhase) record.phase = String(nextPhase);
        if (Number.isFinite(nextTotal) && nextTotal > 0) record.progress.total = nextTotal;
        if (Number.isFinite(current)) record.progress.current = Math.max(0, Math.min(current, record.progress.total));
        if (nextEstimate) record.estimate = clone(nextEstimate);
        record.updatedAt = this.now().toISOString();
      };
      try {
        controller.signal.throwIfAborted();
        record.result = await executor(update, { signal: controller.signal });
        record.status = 'succeeded';
        record.progress.current = record.progress.total;
      } catch (error) {
        record.status = 'failed';
        record.error = cleanError(error);
      } finally {
        record.finishedAt = this.now().toISOString();
        record.updatedAt = record.finishedAt;
        this.executions.delete(record.id);
        settle();
      }
    });
    return clone(record);
  }
}

export function operationIsTerminal(operation) {
  return Boolean(operation && TERMINAL.has(operation.status));
}
