// backend/services/jobState.js
const jobs = new Map(); // jobId -> { ... }

function createJob(by) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job = {
    id,
    by,
    status: 'starting', // starting -> building -> done | error | canceled
    inserted: 0,
    total: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    updatedAt: new Date().toISOString(),
    error: null,
    canceled: false,
  };
  jobs.set(id, job);
  return job;
}

function updateJob(id, patch) {
  const j = jobs.get(id);
  if (!j) return null;
  Object.assign(j, patch, { updatedAt: new Date().toISOString() });
  jobs.set(id, j);
  return j;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function cancelJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  j.canceled = true;
  // keep status as-is unless it is idle; builder will flip to 'canceled'
  j.updatedAt = new Date().toISOString();
  jobs.set(id, j);
  return j;
}

module.exports = { createJob, updateJob, getJob, cancelJob };
