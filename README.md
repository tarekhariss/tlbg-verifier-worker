# TLBG External Verifier Worker

Reference implementation of an external SMTP email-verification worker that
plugs into the TLBG Verification Platform via the `verification-worker-api`
edge function.

> The actual SMTP verification engine runs **outside** Lovable. This worker
> is a thin orchestrator that pulls jobs, hands them to an open-source
> verifier engine, and submits results back. It must never fake successful
> verifications.

---

## Recommended architecture

```
Lovable / Supabase platform
        │  (verification_results, _jobs, _workers, …)
        ▼
verification-worker-api  (edge function, JWT + x-worker-secret protected)
        │
        ▼
External Verifier Worker  (this package — Docker container)
        │
        ▼
Open-source verifier engine
   • AfterShip email-verifier  (Go, MIT) — preferred
   • truemail-go               (Go, MIT) — alternative
   • Reacher                   (only after licensing review)
        │
        ▼
SMTP / MX providers (Gmail, Outlook, custom MTAs, …)
```

The platform never reaches an SMTP server directly. Only this worker does.
That keeps Lovable's IPs out of SMTP reputation systems and lets you scale
egress independently behind your own outbound IPs / proxies.

---

## Quick start (Docker Compose, local)

1. Copy `.env.example` to `.env` and fill in:
   - `SUPABASE_URL` — your Lovable Cloud URL
   - `VERIFICATION_WORKER_SECRET` — the same value set in Lovable
   - `WORKER_ID` — unique id per running instance (e.g. `worker-eu-1`)
   - `VERIFIER_URL` — internal URL of the engine (default
     `http://email-verifier:8080` works with the bundled compose file)

2. Boot it:

   ```bash
   docker compose up -d --build
   ```

   This builds **two local images** from source:
   - `./engine` — a small Go HTTP service wrapping the open-source
     [`AfterShip/email-verifier`](https://github.com/AfterShip/email-verifier)
     library (MIT). Exposes `GET /v1/{email}/verification` on port 8080.
   - `.` — this Node worker that pulls jobs and submits results.

   No private registry images are required.

3. In Lovable, open **Verification → API** and confirm:
   - The worker appears under **Workers** within ~60s
   - The **Connection Checklist** turns green
   - Jobs start draining from the queue when you create a verification job

---

## Deploy on Railway

Create **two services** in the same Railway project, pointed at this repo:

| Service          | Root directory                  | Notes                                                                                       |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `email-verifier` | `external/verifier-worker/engine` | Uses `engine/railway.json` + `engine/Dockerfile`. Exposes port 8080. No public domain needed. |
| `verifier-worker`| `external/verifier-worker`      | Uses `railway.json` + `Dockerfile`. Set env vars below.                                     |

On the **worker** service set:

```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VERIFICATION_WORKER_SECRET=...        # same value as Lovable secret
WORKER_ID=worker-railway-1
VERIFIER_URL=http://email-verifier.railway.internal:8080
```

On the **engine** service set (recommended on Railway, which blocks port 25):

```
DISABLE_SMTP_CHECK=1
```

With `DISABLE_SMTP_CHECK=1` the engine returns syntax + MX + disposable +
role-based + catch-all heuristics; SMTP deliverability is reported as
`unknown` and the worker submits `status: "unknown"` rather than fabricating
a `valid`. To get real SMTP probing, run the engine on a host with outbound
port 25 (a small VPS works) and unset `DISABLE_SMTP_CHECK`.

---

## Worker behaviour (must implement exactly)

| Frequency      | Endpoint        | Purpose                                       |
| -------------- | --------------- | --------------------------------------------- |
| Every 5–15s    | `POST /claim`   | Pull up to N pending verification jobs         |
| Per job        | `POST /submit`  | Submit verification result                    |
| Every 60s      | `POST /heartbeat` | Report status, in-flight, latency, version  |
| On retryable error | `POST /fail` | Mark transient failure (job is retried)       |
| On permanent failure | `POST /dead-letter` | Push to DLQ with reason                  |
| Before batch   | `POST /quota`   | Check workspace quota before consuming        |
| On bounce data | `POST /bounce`  | Forward bounce feedback from SMTP MTA logs    |

Every request **must** include:

```
x-worker-secret: $VERIFICATION_WORKER_SECRET
content-type: application/json
```

If the secret is missing or wrong the API returns `401`.

---

## `/submit` payload (canonical)

```jsonc
{
  "result_id":              "<uuid from /claim>",
  "email":                  "jane.doe@example.com",
  "normalized_email":       "jane.doe@example.com",
  "status":                 "valid | invalid | catch_all | unknown | risky | disposable | failed",
  "confidence_score":       0.0,        // 0..1
  "risk_level":             "low | medium | high",
  "risk_reasons":           ["role_based", "free_provider"],

  "syntax_result":          { "valid": true,  "reason": null },
  "mx_result":              { "valid": true,  "records": ["aspmx.l.google.com"] },
  "smtp_result":            { "valid": true,  "deliverable": true, "full_inbox": false },
  "catch_all_result":       { "is_catch_all": false, "confidence": 0.94 },
  "disposable_result":      { "is_disposable": false },
  "role_based_result":      { "is_role_based": false },

  "mx_provider":            "google",
  "smtp_response_code":     250,
  "smtp_response_message":  "2.1.5 OK",

  "source_engine":          "aftership-email-verifier",
  "engine_version":         "1.7.2",
  "engine_latency_ms":      482,
  "retry_count":            0,
  "verified_at":            "2026-05-24T10:00:00.000Z"
}
```

Any field you can't compute should be omitted or set to `null`. **Never
invent values** — `unknown` is the correct status when the engine cannot
make a determination.

---

## Supported open-source engines

| Engine                          | Language | License | Notes                                              |
| ------------------------------- | -------- | ------- | -------------------------------------------------- |
| AfterShip `email-verifier`      | Go       | MIT     | Preferred. Mature, Dockerised, returns rich JSON. |
| `truemail-go`                   | Go       | MIT     | Good alternative, simpler API.                    |
| Reacher                         | Rust     | mixed   | Only after a licensing review.                    |

This package ships with AfterShip's `email-verifier` by default.

---

## Operational notes

- Run **one worker per outbound IP**. SMTP reputation is per IP.
- Throttle per-domain: max ~1 SMTP probe / 5s / domain to avoid greylisting.
- Use SOCKS5 / SMTP proxies for fan-out; pass them via `PROXY_URL`.
- Retry transient errors (4xx SMTP, timeouts) up to 3 times before
  reporting `/fail`. After 3 fails the platform auto-escalates to DLQ.
- Treat `421` and `4xx` as transient; `5xx` and `550` as permanent.
- Never override the `status` of a previously verified result — submit a
  new result row.

---

## Security

- The worker secret is the **only** credential. Do not commit it.
- The worker never receives a user JWT and cannot read user data.
- Outbound SMTP traffic should leave from dedicated IPs you control.
- Bounce feedback (`/bounce`) feeds the platform's domain reputation
  model and the campaign safety check.

---

## License

MIT for this connector package. Engine licenses apply separately.
