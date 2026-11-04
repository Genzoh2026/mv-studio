// A small in-memory queue for long jobs (separation, beat analysis). One job runs at a time: they are heavy, and the GPU
// or CPU is shared with whatever else the user is doing. The results are files, so a restart loses only the progress.
import { randomUUID } from "node:crypto";

const HISTORY = 40;

/**
 * @param {{run: (job: object, ctx: {signal: AbortSignal, progress: (percent: number) => void}) => Promise<void>}} options
 */
export function createJobs({ run }) {
  const jobs = [];
  const aborts = new Map();
  let working = false;

  function trim() {
    // Finished jobs are kept for a while so the page can show their result or error; the queue itself is never cut.
    const finished = jobs.filter((job) => ["done", "error", "cancelled"].includes(job.state));
    for (const job of finished.slice(0, Math.max(0, finished.length - HISTORY))) jobs.splice(jobs.indexOf(job), 1);
  }

  async function pump() {
    if (working) return;
    working = true;
    try {
      for (let job = jobs.find((j) => j.state === "queued"); job; job = jobs.find((j) => j.state === "queued")) {
        const controller = new AbortController();
        aborts.set(job.id, controller);
        job.state = "running";
        job.startedAt = Date.now();
        try {
          await run(job, { signal: controller.signal, progress: (percent) => { job.progress = Math.max(0, Math.min(100, Math.round(percent))); } });
          job.state = "done";
          job.progress = 100;
        } catch (err) {
          job.state = controller.signal.aborted ? "cancelled" : "error";
          job.error = controller.signal.aborted ? null : err.message;
        } finally {
          aborts.delete(job.id);
          job.finishedAt = Date.now();
        }
      }
    } finally {
      working = false;
      trim();
    }
  }

  return {
    /** Adds a job; the same song and kind already waiting or running returns that job instead of a second one. */
    enqueue(spec) {
      const existing = jobs.find((j) => j.pj === spec.pj && j.base === spec.base && j.kind === spec.kind && ["queued", "running"].includes(j.state));
      if (existing) return existing;
      // A new run of the same job replaces its old result or error.
      for (const old of jobs.filter((j) => j.pj === spec.pj && j.base === spec.base && j.kind === spec.kind)) jobs.splice(jobs.indexOf(old), 1);
      const job = { id: randomUUID(), state: "queued", progress: 0, error: null, queuedAt: Date.now(), startedAt: null, finishedAt: null, ...spec };
      jobs.push(job);
      queueMicrotask(pump);
      return job;
    },

    /** Jobs of one project (or all), without the server-side details. */
    list(pj) {
      return jobs.filter((job) => !pj || job.pj === pj).map(({ id, pj: project, base, kind, state, progress, error, queuedAt, startedAt, finishedAt }) => ({ id, pj: project, base, kind, state, progress, error, queuedAt, startedAt, finishedAt }));
    },

    /** Stops a running job or removes a waiting one. Returns false when there is nothing to cancel. */
    cancel(id) {
      const job = jobs.find((j) => j.id === id);
      if (!job) return false;
      if (job.state === "queued") {
        job.state = "cancelled";
        job.finishedAt = Date.now();
        return true;
      }
      if (job.state === "running") {
        aborts.get(id)?.abort();
        return true;
      }
      return false;
    },

    /** Forgets a finished job (the user dismissed its result). */
    dismiss(id) {
      const job = jobs.find((j) => j.id === id);
      if (!job || ["queued", "running"].includes(job.state)) return false;
      jobs.splice(jobs.indexOf(job), 1);
      return true;
    },

    /** Stops everything (the server is going down). */
    stopAll() {
      for (const job of jobs.filter((j) => j.state === "queued")) job.state = "cancelled";
      for (const controller of aborts.values()) controller.abort();
    },

    running: () => jobs.some((j) => j.state === "running"),

    /** Whether anything is running or waiting (the tool setup must not start then). */
    busy: () => jobs.some((j) => ["queued", "running"].includes(j.state)),
  };
}
