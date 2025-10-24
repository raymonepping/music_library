// backend/utils/retry.js (NEW file)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTimeBudget(ms) {
  const start = Date.now();
  return () => (ms > 0 ? Date.now() - start < ms : true);
}

function isRetriableError(e) {
  const code = e?.code || e?.statusCode || e?.status || e?.response?.status;
  const retriableStatus = [429, 500, 502, 503, 504];
  const retriableCodes = [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ECONNABORTED",
  ];
  return retriableStatus.includes(code) || retriableCodes.includes(code);
}

function retryAfterMs(e, attempt) {
  const ra =
    e?.headers?.["retry-after"] ||
    e?.response?.headers?.["retry-after"] ||
    e?.body?.headers?.["retry-after"];
  if (ra) {
    const s = parseInt(Array.isArray(ra) ? ra[0] : ra, 10);
    if (!Number.isNaN(s) && s > 0) return s * 1000;
  }
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.floor(Math.random() * 400);
}

module.exports = { sleep, makeTimeBudget, isRetriableError, retryAfterMs };
