/**
 * Relay AI Browser Automation Gateway — thin Node HTTP client.
 *
 * Aligned with official Relay Python SDK v2 (`sdk/python/relay_sdk/client.py`):
 *   submit → poll get_status → get_result
 *   or run() which does all three with adaptive backoff.
 *
 * Auth: Authorization: Bearer <RELAY_API_KEY>
 * Base: RELAY_BASE_URL (default https://vmi3391996.tail98bcdc.ts.net)
 */

import axios from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_POLL_SECONDS = 10;
const MAX_POLL_INTERVAL = 30;
const MAX_RETRIES = 3;

function getBaseUrl() {
  return (config.relay.baseUrl || 'https://vmi3391996.tail98bcdc.ts.net').replace(/\/$/, '');
}

function getClient() {
  const apiKey = config.relay.apiKey;
  if (!apiKey) throw new Error('RELAY_API_KEY is not set');

  return axios.create({
    baseURL: getBaseUrl(),
    timeout: 60_000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Bitbash-NicheScout-RelayClient/1.0',
    },
  });
}

function mapHttpError(err) {
  const status = err.response?.status;
  const body = err.response?.data;
  const message =
    (typeof body === 'object' && (body.message || body.error_code))
      ? `${body.error_code || status}: ${body.message || JSON.stringify(body).slice(0, 200)}`
      : err.message;
  const e = new Error(`Relay HTTP ${status || '?'}: ${message}`);
  e.status = status;
  e.body = body;
  e.retryAfter = err.response?.headers?.['retry-after'];
  return e;
}

async function requestWithRetry(fn) {
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const transient = status === 429 || status === 502 || status === 503 || status === 504
        || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED';

      if (transient && attempts <= MAX_RETRIES) {
        let sleepSec = 0.5 * (2 ** (attempts - 1));
        const ra = err.response?.headers?.['retry-after'];
        if (ra) {
          const n = parseFloat(ra);
          if (Number.isFinite(n)) sleepSec = n;
        }
        logger.warn(`[Relay] Transient ${status || err.code} — retry in ${sleepSec}s (${attempts}/${MAX_RETRIES})`);
        await sleep(sleepSec * 1000);
        continue;
      }
      throw err.response ? mapHttpError(err) : err;
    }
  }
}

/**
 * Submit an async job. Returns job_id string.
 * Always sends Idempotency-Key (SDK auto-generates UUID4).
 */
export async function submit({
  prompt,
  serviceId = config.relay.serviceId || 'chatgpt',
  model = 'auto',
  attachmentIds = null,
  priority = 0,
  metadata = null,
  context = null,
  idempotencyKey = null,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('Relay submit: prompt is required');
  }

  const client = getClient();
  const idemKey = idempotencyKey || randomUUID();

  const body = {
    prompt: String(prompt).trim(),
    model,
    priority,
  };
  if (serviceId) body.service_id = serviceId;
  if (attachmentIds?.length) body.attachment_ids = attachmentIds;
  if (metadata) body.metadata = metadata;
  if (context) body.context = context;

  const res = await requestWithRetry(() =>
    client.post('/v1/jobs', body, {
      headers: { 'Idempotency-Key': idemKey },
      validateStatus: (s) => s >= 200 && s < 300,
    })
  );

  const jobId = res.data?.job_id || res.data?.id || res.data?.jobId;
  if (!jobId) {
    throw new Error(`Relay submit: no job_id in response: ${JSON.stringify(res.data).slice(0, 300)}`);
  }

  logger.info(`[Relay] Job submitted: ${jobId} (service=${serviceId || 'default'})`);
  return String(jobId);
}

/** Poll job status. */
export async function getStatus(jobId) {
  if (!jobId) throw new Error('Relay getStatus: job_id required');
  const client = getClient();
  const res = await requestWithRetry(() =>
    client.get(`/v1/jobs/${encodeURIComponent(jobId)}`)
  );
  return res.data;
}

/** Fetch final result for a succeeded job. */
export async function getResult(jobId) {
  if (!jobId) throw new Error('Relay getResult: job_id required');
  const client = getClient();
  const res = await requestWithRetry(() =>
    client.get(`/v1/jobs/${encodeURIComponent(jobId)}/result`)
  );
  return res.data;
}

/** Cancel a queued job. */
export async function cancel(jobId) {
  if (!jobId) throw new Error('Relay cancel: job_id required');
  const client = getClient();
  await requestWithRetry(() =>
    client.delete(`/v1/jobs/${encodeURIComponent(jobId)}`)
  );
}

/**
 * Convenience: submit + adaptive poll + get_result (SDK Client.run).
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.serviceId]
 * @param {string} [opts.model]
 * @param {number} [opts.timeout] - seconds (default 300)
 * @returns {Promise<object>} full result payload from /result
 */
export async function run({
  prompt,
  serviceId = config.relay.serviceId || 'chatgpt',
  model = 'auto',
  timeout = DEFAULT_TIMEOUT_SEC,
  attachmentIds = null,
  priority = 0,
  metadata = null,
  context = null,
} = {}) {
  const started = Date.now();
  const timeoutMs = (timeout || DEFAULT_TIMEOUT_SEC) * 1000;

  const jobId = await submit({
    prompt,
    serviceId,
    model,
    attachmentIds,
    priority,
    metadata,
    context,
  });

  let attempt = 0;
  while (true) {
    const elapsed = Date.now() - started;
    if (elapsed > timeoutMs) {
      throw new Error(`Relay job ${jobId} timed out after ${timeout}s`);
    }

    let statusInfo;
    try {
      statusInfo = await getStatus(jobId);
    } catch (err) {
      logger.warn(`[Relay] getStatus failed for ${jobId}: ${err.message}`);
      await sleep(DEFAULT_POLL_SECONDS * 1000);
      continue;
    }

    const status = String(statusInfo?.status || '').toLowerCase();
    logger.debug(`[Relay] ${jobId} status=${status} queue=${statusInfo?.queue_position ?? '-'}`);

    // SDK terminal: succeeded | failed | blocked | canceled
    if (status === 'succeeded') {
      const finalData = await getResult(jobId);
      logger.info(`[Relay] Job ${jobId} succeeded`);
      return finalData;
    }

    if (status === 'failed' || status === 'blocked') {
      const detail = statusInfo?.safe_error_details || statusInfo?.error_code || status;
      throw new Error(`Relay job ${jobId} ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}`);
    }

    if (status === 'canceled' || status === 'cancelled') {
      throw new Error(`Relay job ${jobId} was canceled`);
    }

    const serverPoll = Number(statusInfo?.poll_after_seconds);
    let sleepSec;
    if (Number.isFinite(serverPoll) && serverPoll > 0) {
      sleepSec = Math.min(serverPoll, MAX_POLL_INTERVAL);
    } else {
      attempt += 1;
      sleepSec = Math.min(2.0 * (1.5 ** attempt), MAX_POLL_INTERVAL);
    }

    const remaining = timeoutMs - (Date.now() - started);
    await sleep(Math.max(1000, Math.min(sleepSec * 1000, remaining)));
  }
}

/** Extract plain text from a Relay result payload. */
export function extractText(resultPayload) {
  if (!resultPayload) return '';
  if (typeof resultPayload === 'string') return resultPayload;
  const text =
    resultPayload?.result?.text
    ?? resultPayload?.text
    ?? resultPayload?.output
    ?? '';
  return typeof text === 'string' ? text : JSON.stringify(text);
}

export default { submit, getStatus, getResult, cancel, run, extractText };
