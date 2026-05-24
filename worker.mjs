// TLBG External Verifier Worker — reference implementation.
//
// Pulls jobs from verification-worker-api, verifies through an open-source
// SMTP verifier engine (default: AfterShip email-verifier), and submits
// results back. Never fakes data.
//
// Run via Docker: see docker-compose.yml.
//
// Required env:
//   SUPABASE_URL, VERIFICATION_WORKER_SECRET, WORKER_ID, VERIFIER_URL

import { request } from "undici";
import { setTimeout as sleep } from "node:timers/promises";

const cfg = {
  base: `${requireEnv("SUPABASE_URL")}/functions/v1/verification-worker-api`,
  secret: requireEnv("VERIFICATION_WORKER_SECRET"),
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  workerVersion: process.env.WORKER_VERSION ?? "1.0.0",
  host: process.env.WORKER_HOST ?? "unknown",
  verifierUrl: process.env.VERIFIER_URL ?? "http://email-verifier:8080",
  engine: process.env.VERIFIER_ENGINE ?? "aftership-email-verifier",
  engineVersion: process.env.VERIFIER_VERSION ?? "unknown",
  claimBatch: Number(process.env.CLAIM_BATCH_SIZE ?? 50),
  claimInterval: Number(process.env.CLAIM_INTERVAL_MS ?? 5000),
  heartbeatInterval: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 60_000),
  concurrency: Number(process.env.MAX_CONCURRENCY ?? 10),
  perDomainDelay: Number(process.env.PER_DOMAIN_DELAY_MS ?? 5000),
  maxRetries: Number(process.env.MAX_RETRIES ?? 3),
  // Recovery loop (unknown-recovery optimization)
  recoveryInterval: Number(process.env.RECOVERY_INTERVAL_MS ?? 15_000),
  recoveryConcurrency: Number(process.env.RECOVERY_CONCURRENCY ?? 5),
  heloPool: (process.env.SMTP_HELO_POOL ?? "").split(",").map(s => s.trim()).filter(Boolean),
  fromPool: (process.env.SMTP_FROM_POOL ?? "").split(",").map(s => s.trim()).filter(Boolean),
};

function requireEnv(k) {
  const v = process.env[k];
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
  return v;
}

const stats = { processed: 0, inFlight: 0, recoveryInFlight: 0, recoveryProcessed: 0, latencies: [], lastError: null };
const lastDomainHitAt = new Map();
const mxPool = new Map(); // per-MX serial queue { last: ts, queue: Promise }

async function api(path, body) {
  const res = await request(`${cfg.base}${path}`, {
    method: "POST",
    headers: {
      "x-worker-secret": cfg.secret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.body.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (res.statusCode >= 400) {
    throw new Error(`${path} ${res.statusCode}: ${parsed.error ?? text}`);
  }
  return parsed;
}

// ---- Engine adapter (AfterShip email-verifier shape). Replace for another engine. ----
async function verifyEmail(email) {
  const t0 = Date.now();
  const res = await request(`${cfg.verifierUrl}/v1/${encodeURIComponent(email)}/verification`, {
    method: "GET",
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });
  const body = await res.body.json().catch(() => ({}));
  const latency = Date.now() - t0;

  if (res.statusCode >= 500) throw new Error(`engine_5xx:${res.statusCode}`);

  // Map engine output → canonical platform shape. Never invent fields.
  const syntaxValid = !!body?.syntax?.valid;
  const mxValid = !!body?.has_mx_records;
  const smtpDeliverable = !!body?.smtp?.deliverable;
  const fullInbox = !!body?.smtp?.full_inbox;
  const isCatchAll = !!body?.smtp?.catch_all;
  const isDisposable = !!body?.disposable;
  const isRole = !!body?.role_account;
  const reachable = body?.reachable ?? "unknown"; // yes | no | unknown

  let status = "unknown";
  if (!syntaxValid) status = "invalid";
  else if (isDisposable) status = "disposable";
  else if (!mxValid) status = "invalid";
  else if (reachable === "yes") status = isCatchAll ? "catch_all" : "valid";
  else if (reachable === "no") status = "invalid";
  else status = "unknown";

  const confidence =
    status === "valid" ? 0.95 :
    status === "invalid" ? 0.99 :
    status === "catch_all" ? 0.60 :
    status === "disposable" ? 0.99 :
    0.40;

  const risk_reasons = [];
  if (isRole) risk_reasons.push("role_based");
  if (isCatchAll) risk_reasons.push("catch_all");
  if (body?.free) risk_reasons.push("free_provider");
  if (fullInbox) risk_reasons.push("full_inbox");

  const risk_level = status === "valid" && risk_reasons.length === 0
    ? "low" : status === "valid" ? "medium" : "high";

  return {
    status,
    confidence_score: confidence,
    risk_level,
    risk_reasons,
    syntax_result: { valid: syntaxValid, reason: body?.syntax?.reason ?? null },
    mx_result: { valid: mxValid, records: body?.mx ?? [] },
    smtp_result: {
      valid: smtpDeliverable,
      deliverable: smtpDeliverable,
      full_inbox: fullInbox,
    },
    catch_all_result: { is_catch_all: isCatchAll, confidence: isCatchAll ? 0.9 : 0.95 },
    disposable_result: { is_disposable: isDisposable },
    role_based_result: { is_role_based: isRole },
    mx_provider: body?.smtp?.host_exists ? (body?.mx?.[0]?.host ?? null) : null,
    smtp_response_code: body?.smtp?.smtp_code ?? null,
    smtp_response_message: body?.smtp?.smtp_message ?? null,
    source_engine: cfg.engine,
    engine_version: cfg.engineVersion,
    engine_latency_ms: latency,
    verified_at: new Date().toISOString(),
    raw: body,
  };
}

// ---- Per-domain throttle ----
async function throttleDomain(email) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const last = lastDomainHitAt.get(domain) ?? 0;
  const wait = Math.max(0, cfg.perDomainDelay - (Date.now() - last));
  if (wait > 0) await sleep(wait);
  lastDomainHitAt.set(domain, Date.now());
}

// ---- Process a single claimed job ----
async function processOne(job) {
  stats.inFlight++;
  try {
    await throttleDomain(job.email);
    let attempt = 0; let lastErr;
    while (attempt <= cfg.maxRetries) {
      try {
        const result = await verifyEmail(job.email);
        await api("/submit", {
          result_id: job.result_id ?? job.id,
          email: job.email,
          normalized_email: job.email.toLowerCase(),
          retry_count: attempt,
          ...result,
        });
        stats.latencies.push(result.engine_latency_ms);
        if (stats.latencies.length > 100) stats.latencies.shift();
        stats.processed++;
        return;
      } catch (e) {
        lastErr = e;
        attempt++;
        if (attempt > cfg.maxRetries) break;
        await sleep(1000 * attempt);
      }
    }
    // Transient: report /fail so platform reschedules
    await api("/fail", { result_id: job.result_id ?? job.id, error: String(lastErr?.message ?? lastErr) });
  } catch (e) {
    // Permanent: push to DLQ
    stats.lastError = String(e?.message ?? e);
    await api("/dead-letter", {
      workspace_id: job.workspace_id,
      result_id: job.result_id ?? job.id,
      job_id: job.job_id ?? null,
      email: job.email,
      reason: "worker_permanent_failure",
      attempt_count: cfg.maxRetries,
      last_error: stats.lastError,
    }).catch(() => {});
  } finally {
    stats.inFlight--;
  }
}

// ---- Main loops ----
async function heartbeatLoop() {
  for (;;) {
    try {
      const avg = stats.latencies.length
        ? Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length)
        : null;
      await api("/heartbeat", {
        worker_id: cfg.workerId,
        status: (stats.inFlight + stats.recoveryInFlight) > 0 ? "online" : "idle",
        in_flight: stats.inFlight,
        batch_size: cfg.claimBatch,
        avg_latency: avg,
        version: cfg.workerVersion,
        host: cfg.host,
        last_error: stats.lastError,
        metadata: {
          engine: cfg.engine,
          engine_version: cfg.engineVersion,
          recovery_in_flight: stats.recoveryInFlight,
          recovery_processed: stats.recoveryProcessed,
        },
      });
    } catch (e) {
      console.error("[heartbeat]", e.message);
    }
    await sleep(cfg.heartbeatInterval);
  }
}

async function claimLoop() {
  for (;;) {
    try {
      if (stats.inFlight >= cfg.concurrency) {
        await sleep(500); continue;
      }
      const room = cfg.concurrency - stats.inFlight;
      const limit = Math.min(cfg.claimBatch, room);

      // Pick the workspace_id from first claimed job to check quota
      const { batch } = await api("/claim", { limit });
      if (!batch?.length) { await sleep(cfg.claimInterval); continue; }

      // Pre-flight quota check per workspace
      const byWs = new Map();
      for (const j of batch) {
        if (!byWs.has(j.workspace_id)) byWs.set(j.workspace_id, []);
        byWs.get(j.workspace_id).push(j);
      }
      for (const [workspace_id, jobs] of byWs) {
        const qr = await api("/quota", { workspace_id, consume: true, count: jobs.length });
        if (qr?.allowed?.ok === false) {
          console.warn(`[quota] workspace ${workspace_id} blocked: ${qr.allowed.reason}`);
          for (const j of jobs) {
            await api("/dead-letter", {
              workspace_id, result_id: j.result_id ?? j.id, email: j.email,
              reason: `quota:${qr.allowed.reason}`, attempt_count: 0,
            }).catch(() => {});
          }
          continue;
        }
        // Fire-and-track
        for (const j of jobs) processOne(j);
      }
    } catch (e) {
      stats.lastError = String(e?.message ?? e);
      console.error("[claim]", stats.lastError);
      await sleep(cfg.claimInterval);
    }
  }
}

// ---- Recovery loop: drain verification_recovery_queue with provider-aware timing ----
function pick(arr, fallback) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : fallback; }

async function mxThrottle(host, delayMs) {
  if (!host) return;
  const slot = mxPool.get(host) ?? { last: 0 };
  const wait = Math.max(0, delayMs - (Date.now() - slot.last));
  if (wait > 0) await sleep(wait);
  slot.last = Date.now();
  mxPool.set(host, slot);
}

async function verifyForRecovery(email, hints) {
  // Apply provider-aware timeout & optional HELO rotation.
  const timeout = hints?.pass_number === 5
    ? (hints.extended_timeout_ms ?? 60000)
    : (hints?.smtp_timeout_ms ?? 25000);
  const helo = hints?.helo_rotation ? pick(cfg.heloPool, undefined) : undefined;
  const url = new URL(`${cfg.verifierUrl}/v1/${encodeURIComponent(email)}/verification`);
  if (helo) url.searchParams.set("helo", helo);

  const t0 = Date.now();
  const res = await request(url.toString(), {
    method: "GET",
    headersTimeout: timeout + 5000,
    bodyTimeout: timeout + 5000,
  });
  const body = await res.body.json().catch(() => ({}));
  const latency = Date.now() - t0;

  const syntaxValid = !!body?.syntax?.valid;
  const mxValid = !!body?.has_mx_records;
  const reachable = body?.reachable ?? "unknown";
  const isCatchAll = !!body?.smtp?.catch_all;
  const isDisposable = !!body?.disposable;

  let status = "unknown";
  if (!syntaxValid) status = "invalid";
  else if (isDisposable) status = "disposable";
  else if (!mxValid) status = "invalid";
  else if (reachable === "yes") status = isCatchAll ? "catch_all" : "valid";
  else if (reachable === "no") status = "invalid";

  return {
    status,
    smtp_code: body?.smtp?.smtp_code ?? null,
    smtp_text: body?.smtp?.smtp_message ?? null,
    latency_ms: latency,
    banner: body?.smtp?.banner ?? null,
    mx_host: body?.mx?.[0]?.host ?? null,
    helo_used: helo ?? null,
    tls_used: !!body?.smtp?.tls,
    disconnect_reason: body?.smtp?.disconnect ?? null,
  };
}

async function processRecoveryItem(item) {
  stats.recoveryInFlight++;
  try {
    // Greylisting-aware tiny pre-wait when reason is greylisting (let server flush its tarpit)
    if (item.reason_code === "greylisting") await sleep(2000);
    await mxThrottle(item.domain, item.per_domain_delay_ms ?? 5000);
    const r = await verifyForRecovery(item.email, item);
    await api("/recovery-submit", {
      recovery_id: item.id,
      status: r.status,
      smtp_code: r.smtp_code,
      smtp_text: r.smtp_text,
      latency_ms: r.latency_ms,
      banner: r.banner,
      mx_host: r.mx_host,
      helo_used: r.helo_used,
      tls_used: r.tls_used,
      disconnect_reason: r.disconnect_reason,
    });
    stats.recoveryProcessed++;
  } catch (e) {
    await api("/recovery-submit", {
      recovery_id: item.id,
      status: "unknown",
      smtp_text: String(e?.message ?? e).slice(0, 300),
      latency_ms: null,
    }).catch(() => {});
  } finally {
    stats.recoveryInFlight--;
  }
}

async function recoveryLoop() {
  for (;;) {
    try {
      const room = cfg.recoveryConcurrency - stats.recoveryInFlight;
      if (room <= 0) { await sleep(1000); continue; }
      const { batch } = await api("/recovery-claim", { worker_id: cfg.workerId, limit: room });
      if (!batch?.length) { await sleep(cfg.recoveryInterval); continue; }
      for (const item of batch) processRecoveryItem(item);
    } catch (e) {
      console.error("[recovery]", e.message);
      await sleep(cfg.recoveryInterval);
    }
  }
}

console.log(`[boot] ${cfg.workerId} → ${cfg.base}  engine=${cfg.engine}@${cfg.verifierUrl}`);
heartbeatLoop();
claimLoop();
recoveryLoop();
