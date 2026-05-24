// TLBG External Verifier Worker — reference implementation.
//
// Pulls jobs from verification-worker-api, verifies through the AfterShip
// email-verifier engine, and submits results back. Adds:
//   - Per-MX / per-provider concurrency caps (anti-abuse + accuracy)
//   - Quality modes: fast | balanced | high_accuracy (default balanced)
//   - Conservative Node-side SMTP probe (banner/EHLO/STARTTLS/TLS) on
//     unknown / retry / high-accuracy results to feed SMTP intelligence
//   - Adaptive throttling on transient SMTP failures
//   - Recovery loop for the recovery queue (greylisting / multi-pass)
//
// Required env:
//   SUPABASE_URL, VERIFICATION_WORKER_SECRET, WORKER_ID, VERIFIER_URL

import { request } from "undici";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";

const cfg = {
  base: `${requireEnv("SUPABASE_URL")}/functions/v1/verification-worker-api`,
  secret: requireEnv("VERIFICATION_WORKER_SECRET"),
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  workerVersion: process.env.WORKER_VERSION ?? "1.1.0",
  host: process.env.WORKER_HOST ?? "unknown",
  verifierUrl: process.env.VERIFIER_URL ?? "http://email-verifier:8080",
  engine: process.env.VERIFIER_ENGINE ?? "aftership-email-verifier",
  engineVersion: process.env.VERIFIER_VERSION ?? "unknown",
  claimBatch: Number(process.env.CLAIM_BATCH_SIZE ?? 25),
  claimInterval: Number(process.env.CLAIM_INTERVAL_MS ?? 5000),
  heartbeatInterval: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 60_000),
  concurrency: Number(process.env.MAX_CONCURRENCY ?? 10),
  perDomainDelay: Number(process.env.PER_DOMAIN_DELAY_MS ?? 5000),
  maxRetries: Number(process.env.MAX_RETRIES ?? 3),
  // Recovery loop
  recoveryInterval: Number(process.env.RECOVERY_INTERVAL_MS ?? 15_000),
  recoveryConcurrency: Number(process.env.RECOVERY_CONCURRENCY ?? 5),
  heloPool: (process.env.SMTP_HELO_POOL ?? "").split(",").map(s => s.trim()).filter(Boolean),
  fromPool: (process.env.SMTP_FROM_POOL ?? "").split(",").map(s => s.trim()).filter(Boolean),
  // SMTP probe
  probeHelo: process.env.SMTP_PROBE_HELO || process.env.SMTP_HELO_NAME || "verifier.tlbg.cloud",
  probeFrom: process.env.SMTP_PROBE_FROM || process.env.SMTP_FROM_EMAIL || "postmaster@tlbg.cloud",
  probeEnabled: (process.env.SMTP_PROBE_ENABLED ?? "1") !== "0",
};

function requireEnv(k) {
  const v = process.env[k];
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
  return v;
}

// ---- Quality mode profiles --------------------------------------------------
// `claim` from the platform returns a `quality_mode` per row.
const MODE_PROFILES = {
  fast: {
    concurrency: cfg.concurrency,
    perDomainDelayMs: Math.max(1000, Math.floor(cfg.perDomainDelay / 2)),
    perMxConcurrency: 4,
    timeoutMs: 15_000,
    maxRetries: 1,
    probe: "never",
  },
  balanced: {
    concurrency: Math.max(4, Math.floor(cfg.concurrency * 0.6)),
    perDomainDelayMs: cfg.perDomainDelay,
    perMxConcurrency: 2,
    timeoutMs: 25_000,
    maxRetries: 2,
    probe: "on_unknown_or_retry",
  },
  high_accuracy: {
    concurrency: Math.max(2, Math.floor(cfg.concurrency * 0.3)),
    perDomainDelayMs: Math.max(cfg.perDomainDelay, 8000),
    perMxConcurrency: 1,
    timeoutMs: 45_000,
    maxRetries: 3,
    probe: "always",
  },
  // Back-compat for legacy `standard` / `high`
  standard: null,
  high: null,
};
MODE_PROFILES.standard = MODE_PROFILES.balanced;
MODE_PROFILES.high = MODE_PROFILES.high_accuracy;
function profileFor(mode) {
  return MODE_PROFILES[mode] ?? MODE_PROFILES.balanced;
}

// ---- Provider classification by MX hostname --------------------------------
// Used for provider-aware concurrency caps and persisted to verification_results.
const PROVIDER_RULES = [
  [/(^|\.)google\.com\.?$|aspmx\.l\.google\.com|googlemail\.com/i, "google_workspace"],
  [/(^|\.)outlook\.com\.?$|protection\.outlook\.com|olc\.protection\.outlook\.com/i, "microsoft365"],
  [/(^|\.)pphosted\.com\.?$|ppe-hosted\.com|proofpoint\.com/i, "proofpoint"],
  [/mimecast(\.com|\.co\.za)/i, "mimecast"],
  [/barracudanetworks\.com|barracuda\.com/i, "barracuda"],
  [/(^|\.)yahoodns\.net\.?$|yahoo\.com/i, "yahoo"],
  [/(^|\.)mx\.cloudflare\.net\.?$/i, "cloudflare"],
  [/iphmx\.com|cisco\.com/i, "cisco_ironport"],
  [/spamtitan|titanhq/i, "spamtitan"],
  [/(^|\.)zoho\.com\.?$/i, "zoho"],
  [/(^|\.)protonmail\.ch\.?$|proton\.me/i, "proton"],
  [/(^|\.)secureserver\.net\.?$/i, "godaddy"],
];
function classifyProvider(mxHost) {
  if (!mxHost) return "unknown";
  const h = String(mxHost).toLowerCase();
  for (const [re, name] of PROVIDER_RULES) if (re.test(h)) return name;
  return "custom_smtp";
}

// Provider-aware concurrency caps. Conservative defaults; can be tuned later
// from the /intelligence endpoint feed.
const PROVIDER_CAPS = {
  google_workspace: 6,
  microsoft365: 3,
  proofpoint: 1,
  mimecast: 1,
  barracuda: 2,
  yahoo: 2,
  cloudflare: 4,
  cisco_ironport: 2,
  spamtitan: 2,
  zoho: 3,
  proton: 2,
  godaddy: 3,
  custom_smtp: 4,
  unknown: 4,
};

// ---- Stats & limiters ------------------------------------------------------
const stats = {
  processed: 0, inFlight: 0,
  recoveryInFlight: 0, recoveryProcessed: 0,
  probesRun: 0, probeFailures: 0,
  latencies: [], lastError: null,
};
const lastDomainHitAt = new Map();        // domain → ts
const mxLastHitAt = new Map();            // mxHost → ts
const mxInFlight = new Map();             // mxHost → count
const providerInFlight = new Map();       // providerKey → count
const mxBackoff = new Map();              // mxHost → ts (do-not-touch-before)

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

// ---- Engine adapter (AfterShip email-verifier shape) -----------------------
async function callEngine(email, timeoutMs) {
  const t0 = Date.now();
  const res = await request(`${cfg.verifierUrl}/v1/${encodeURIComponent(email)}/verification`, {
    method: "GET",
    headersTimeout: timeoutMs + 5000,
    bodyTimeout: timeoutMs + 5000,
  });
  const body = await res.body.json().catch(() => ({}));
  const latency = Date.now() - t0;
  if (res.statusCode >= 500) throw new Error(`engine_5xx:${res.statusCode}`);
  return { body, latency, statusCode: res.statusCode };
}

function mapEngineResult({ body, latency }, email, providerKey) {
  const syntaxValid = !!body?.syntax?.valid;
  const mxValid = !!body?.has_mx_records;
  const smtpDeliverable = !!body?.smtp?.deliverable;
  const fullInbox = !!body?.smtp?.full_inbox;
  const isCatchAll = !!body?.smtp?.catch_all;
  const isDisposable = !!body?.disposable;
  const isRole = !!body?.role_account;
  const reachable = body?.reachable ?? "unknown";

  let status = "unknown";
  if (!syntaxValid) status = "invalid";
  else if (isDisposable) status = "disposable";
  else if (!mxValid) status = "invalid";
  else if (reachable === "yes") status = isCatchAll ? "catch_all" : "valid";
  else if (reachable === "no") status = "invalid";

  const confidence =
    status === "valid" ? 0.95 :
    status === "invalid" ? 0.99 :
    status === "catch_all" ? 0.60 :
    status === "disposable" ? 0.99 : 0.40;

  const risk_reasons = [];
  if (isRole) risk_reasons.push("role_based");
  if (isCatchAll) risk_reasons.push("catch_all");
  if (body?.free) risk_reasons.push("free_provider");
  if (fullInbox) risk_reasons.push("full_inbox");

  return {
    status,
    confidence_score: confidence,
    risk_level: status === "valid" && risk_reasons.length === 0 ? "low" : status === "valid" ? "medium" : "high",
    risk_reasons,
    is_disposable: isDisposable,
    is_role_based: isRole,
    is_catch_all: isCatchAll,
    is_free_provider: !!body?.free,
    mx_provider: providerKey,
    mx_record: body?.mx?.[0]?.host ?? null,
    smtp_response: body?.smtp?.smtp_message ?? null,
    smtp_code: body?.smtp?.smtp_code ?? null,
    source_engine: cfg.engine,
    engine_version: cfg.engineVersion,
    engine_latency_ms: latency,
    raw: body,
  };
}

// ---- Conservative Node-side SMTP probe -------------------------------------
// Only run on unknown / retry / high-accuracy cases. Captures banner, EHLO,
// STARTTLS availability, TLS handshake outcome, disconnect timing.
// Does NOT issue RCPT TO (no extra deliverability noise). Pure session probe.
function readSmtpLines(sock, expectCodePrefix, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      // SMTP "###-..." continuations end on a "### " line.
      const lines = buf.split(/\r?\n/);
      const last = lines.findLast?.((l) => /^\d{3} /.test(l)) ?? lines.reverse().find((l) => /^\d{3} /.test(l));
      if (last) {
        sock.off("data", onData);
        clearTimeout(timer);
        const code = parseInt(last.slice(0, 3), 10);
        resolve({ code, text: buf.trim() });
      }
    };
    const timer = setTimeout(() => {
      sock.off("data", onData);
      reject(new Error("smtp_timeout"));
    }, timeoutMs);
    sock.on("data", onData);
    sock.once("error", (e) => { clearTimeout(timer); reject(e); });
    sock.once("end", () => { clearTimeout(timer); if (buf) resolve({ code: 0, text: buf.trim() }); });
  });
}

async function smtpProbe(email, mxHost, timeoutMs) {
  const start = Date.now();
  const out = {
    ok: false,
    smtp_banner: null,
    ehlo_response: null,
    smtp_code: null,
    smtp_text: null,
    starttls_advertised: false,
    tls_supported: null,
    tls_protocol: null,
    disconnect_reason: null,
    latency_ms: null,
  };
  if (!mxHost) { out.disconnect_reason = "no_mx_host"; return out; }
  let sock;
  try {
    sock = net.createConnection({ host: mxHost, port: 25, family: 0 });
    sock.setTimeout(timeoutMs);
    await new Promise((res, rej) => {
      sock.once("connect", res);
      sock.once("timeout", () => rej(new Error("connect_timeout")));
      sock.once("error", rej);
    });

    const banner = await readSmtpLines(sock, "220", timeoutMs);
    out.smtp_banner = banner.text.slice(0, 500);
    out.smtp_code = banner.code;
    if (banner.code !== 220) {
      out.disconnect_reason = `bad_banner:${banner.code}`;
      return out;
    }

    sock.write(`EHLO ${cfg.probeHelo}\r\n`);
    const ehlo = await readSmtpLines(sock, "250", timeoutMs);
    out.ehlo_response = ehlo.text.slice(0, 800);
    out.starttls_advertised = /\bSTARTTLS\b/i.test(ehlo.text);

    if (out.starttls_advertised) {
      sock.write("STARTTLS\r\n");
      const sttls = await readSmtpLines(sock, "220", timeoutMs);
      if (sttls.code === 220) {
        try {
          const secured = await new Promise((res, rej) => {
            const s = tls.connect({
              socket: sock,
              servername: mxHost,
              rejectUnauthorized: false,
              ALPNProtocols: undefined,
            }, () => res(s));
            s.once("error", rej);
            setTimeout(() => rej(new Error("tls_handshake_timeout")), timeoutMs);
          });
          out.tls_supported = true;
          out.tls_protocol = secured.getProtocol?.() ?? null;
          try { secured.write("QUIT\r\n"); } catch {}
          try { secured.end(); } catch {}
          out.ok = true;
          out.disconnect_reason = "graceful_quit";
          return out;
        } catch (e) {
          out.tls_supported = false;
          out.disconnect_reason = `tls_failure:${String(e?.message ?? e).slice(0, 80)}`;
          return out;
        }
      }
    }

    try { sock.write("QUIT\r\n"); } catch {}
    out.ok = true;
    out.disconnect_reason = "graceful_quit";
    return out;
  } catch (e) {
    out.disconnect_reason = `probe_error:${String(e?.message ?? e).slice(0, 80)}`;
    return out;
  } finally {
    out.latency_ms = Date.now() - start;
    try { sock?.destroy(); } catch {}
  }
}

// ---- Throttling helpers -----------------------------------------------------
async function throttleDomainAndMx(email, mxHost, profile) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";

  // Per-domain pacing
  const lastDom = lastDomainHitAt.get(domain) ?? 0;
  const domWait = Math.max(0, profile.perDomainDelayMs - (Date.now() - lastDom));
  if (domWait > 0) await sleep(domWait);
  lastDomainHitAt.set(domain, Date.now());

  // Per-MX adaptive backoff (set by transient failures)
  if (mxHost) {
    const back = mxBackoff.get(mxHost) ?? 0;
    const backWait = Math.max(0, back - Date.now());
    if (backWait > 0) await sleep(Math.min(backWait, 30_000));
  }

  // Per-MX concurrency
  if (mxHost) {
    while ((mxInFlight.get(mxHost) ?? 0) >= profile.perMxConcurrency) {
      await sleep(200);
    }
    mxInFlight.set(mxHost, (mxInFlight.get(mxHost) ?? 0) + 1);
  }
}

function releaseMx(mxHost) {
  if (!mxHost) return;
  const next = (mxInFlight.get(mxHost) ?? 1) - 1;
  if (next <= 0) mxInFlight.delete(mxHost);
  else mxInFlight.set(mxHost, next);
}

function noteTransient(mxHost) {
  if (!mxHost) return;
  // Exponential backoff up to 60s
  const prev = mxBackoff.get(mxHost) ?? Date.now();
  const delay = Math.min(60_000, Math.max(2000, (prev - Date.now()) * 2 || 2000));
  mxBackoff.set(mxHost, Date.now() + delay);
}

function isTransientStatus(status, smtpCode) {
  if (status === "unknown") return true;
  if (smtpCode && smtpCode >= 400 && smtpCode < 500) return true;
  return false;
}

// ---- MX resolution cache (lightweight) -------------------------------------
const mxCache = new Map();
async function resolveMx(domain) {
  if (!domain) return null;
  if (mxCache.has(domain)) return mxCache.get(domain);
  try {
    const recs = await dns.resolveMx(domain);
    recs.sort((a, b) => a.priority - b.priority);
    const host = recs[0]?.exchange ?? null;
    mxCache.set(domain, host);
    return host;
  } catch {
    mxCache.set(domain, null);
    return null;
  }
}

// ---- Process a single claimed job -----------------------------------------
async function processOne(job) {
  stats.inFlight++;
  const mode = job.quality_mode ?? "balanced";
  const profile = profileFor(mode);
  const domain = job.email.split("@")[1]?.toLowerCase() ?? "";
  let mxHost = null;
  try {
    mxHost = await resolveMx(domain);
    const providerKey = classifyProvider(mxHost);

    await throttleDomainAndMx(job.email, mxHost, profile);

    let attempt = 0; let lastErr; let engineOut;
    while (attempt <= profile.maxRetries) {
      try {
        engineOut = await callEngine(job.email, profile.timeoutMs);
        break;
      } catch (e) {
        lastErr = e;
        attempt++;
        if (attempt > profile.maxRetries) {
          throw e;
        }
        await sleep(1000 * attempt);
      }
    }

    const mapped = mapEngineResult(engineOut, job.email, providerKey);

    // Decide whether to run the deep SMTP probe.
    const shouldProbe = cfg.probeEnabled && (
      profile.probe === "always" ||
      (profile.probe === "on_unknown_or_retry" && (mapped.status === "unknown" || attempt > 0))
    );

    let probe = null;
    if (shouldProbe) {
      try {
        probe = await smtpProbe(job.email, mxHost ?? mapped.mx_record, Math.min(profile.timeoutMs, 30_000));
        stats.probesRun++;
        if (!probe.ok) stats.probeFailures++;
      } catch (e) {
        stats.probeFailures++;
        probe = { disconnect_reason: `probe_threw:${String(e?.message ?? e).slice(0, 80)}` };
      }
    }

    // Adaptive throttle on transient
    if (isTransientStatus(mapped.status, mapped.smtp_code)) {
      noteTransient(mxHost);
    }

    await api("/submit", {
      result_id: job.result_id ?? job.id,
      email: job.email,
      normalized_email: job.email.toLowerCase(),
      retry_count: attempt,
      provider_type: providerKey,
      mx_host: mxHost,
      ...mapped,
      // SMTP intelligence (consumed by edge function PATCH below)
      smtp_banner: probe?.smtp_banner ?? null,
      tls_supported: probe?.tls_supported ?? null,
      disconnect_reason: probe?.disconnect_reason ?? null,
      probe_metadata: probe ? {
        ehlo: probe.ehlo_response,
        starttls_advertised: probe.starttls_advertised,
        tls_protocol: probe.tls_protocol,
        latency_ms: probe.latency_ms,
        mx_host: mxHost,
        provider: providerKey,
        mode,
      } : { mode, provider: providerKey, mx_host: mxHost, probed: false },
    });

    stats.latencies.push(mapped.engine_latency_ms);
    if (stats.latencies.length > 100) stats.latencies.shift();
    stats.processed++;
  } catch (e) {
    stats.lastError = String(e?.message ?? e);
    await api("/fail", {
      result_id: job.result_id ?? job.id,
      error: stats.lastError,
      reason: stats.lastError.includes("greylist") ? "greylisted" : "transient",
    }).catch(() => {});
  } finally {
    releaseMx(mxHost);
    stats.inFlight--;
  }
}

// ---- Main loops -------------------------------------------------------------
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
        throughput: stats.processed,
        metadata: {
          engine: cfg.engine,
          engine_version: cfg.engineVersion,
          recovery_in_flight: stats.recoveryInFlight,
          recovery_processed: stats.recoveryProcessed,
          probes_run: stats.probesRun,
          probe_failures: stats.probeFailures,
          mx_pool_size: mxInFlight.size,
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
      const { batch } = await api("/claim", { limit });
      if (!batch?.length) { await sleep(cfg.claimInterval); continue; }

      // Pre-flight quota by workspace
      const byWs = new Map();
      for (const j of batch) {
        if (!byWs.has(j.workspace_id)) byWs.set(j.workspace_id, []);
        byWs.get(j.workspace_id).push(j);
      }
      for (const [workspace_id, jobs] of byWs) {
        const qr = await api("/quota", { workspace_id, consume: true, count: jobs.length });
        if (qr?.allowed?.ok === false) {
          for (const j of jobs) {
            await api("/dead-letter", {
              workspace_id, result_id: j.result_id ?? j.id, email: j.email,
              reason: `quota:${qr.allowed.reason}`, attempt_count: 0,
            }).catch(() => {});
          }
          continue;
        }
        for (const j of jobs) processOne(j);
      }
    } catch (e) {
      stats.lastError = String(e?.message ?? e);
      console.error("[claim]", stats.lastError);
      await sleep(cfg.claimInterval);
    }
  }
}

// ---- Recovery loop ---------------------------------------------------------
function pick(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined; }

async function processRecoveryItem(item) {
  stats.recoveryInFlight++;
  const domain = item.domain ?? item.email?.split("@")[1]?.toLowerCase() ?? "";
  let mxHost = null;
  try {
    if (item.reason_code === "greylisting") await sleep(2000);
    mxHost = await resolveMx(domain);
    const providerKey = classifyProvider(mxHost);
    const profile = profileFor(item.pass_number >= 4 ? "high_accuracy" : "balanced");
    await throttleDomainAndMx(item.email, mxHost, profile);

    const engineOut = await callEngine(item.email, profile.timeoutMs).catch((e) => { throw e; });
    const mapped = mapEngineResult(engineOut, item.email, providerKey);
    const probe = await smtpProbe(item.email, mxHost ?? mapped.mx_record, profile.timeoutMs).catch(() => null);

    await api("/recovery-submit", {
      recovery_id: item.id,
      status: mapped.status,
      smtp_code: mapped.smtp_code,
      smtp_text: mapped.smtp_response,
      latency_ms: mapped.engine_latency_ms,
      banner: probe?.smtp_banner ?? null,
      mx_host: mxHost,
      helo_used: cfg.probeHelo,
      tls_used: probe?.tls_supported ?? null,
      disconnect_reason: probe?.disconnect_reason ?? null,
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
    releaseMx(mxHost);
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

console.log(`[boot] ${cfg.workerId} v${cfg.workerVersion} → ${cfg.base}  engine=${cfg.engine}@${cfg.verifierUrl}  probe=${cfg.probeEnabled ? "on" : "off"}`);
heartbeatLoop();
claimLoop();
recoveryLoop();
