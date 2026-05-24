# TLBG Verifier Worker

Standalone external worker for the **TLBG Prospect Intelligence** platform.
Pulls pending email verification jobs from the platform's
`verification-worker-api` edge function, verifies them through an
open-source SMTP verifier engine, and submits canonical results back.

**Never** fakes data. **Never** simulates results.

```
TLBG Platform (Lovable + Supabase)
        │  verification-worker-api  (x-worker-secret auth)
        ▼
TLBG Verifier Worker  (this repo)
        │  HTTP
        ▼
Open-source verifier engine (AfterShip email-verifier / truemail-go)
        │  SMTP / MX
        ▼
Email service providers
```

---

## Repository layout

```
tlbg-verifier-worker/
├── worker.mjs            # Worker process (claim → verify → submit)
├── package.json
├── Dockerfile            # Production container
├── docker-compose.yml    # Local dev: worker + email-verifier engine
├── railway.json          # Railway build/deploy config
├── .env.example
├── .dockerignore
└── .gitignore
```

---

## Required environment variables

| Variable                       | Required | Description |
|--------------------------------|----------|-------------|
| `SUPABASE_WORKER_API_URL`      | yes      | Full URL to `verification-worker-api` (e.g. `https://YOUR-PROJECT.supabase.co/functions/v1/verification-worker-api`). |
| `VERIFICATION_WORKER_SECRET`   | yes      | Shared secret — must match the platform secret. Sent as `x-worker-secret`. |
| `VERIFIER_URL`                 | yes      | URL of the SMTP verifier engine. |
| `WORKER_ID`                    | no       | Stable worker identifier (default `worker-<pid>`). |
| `WORKER_VERSION`, `WORKER_HOST`| no       | Reported via `/heartbeat`. |
| `VERIFIER_ENGINE`, `VERIFIER_VERSION` | no | Engine metadata reported with each result. |
| `CLAIM_BATCH_SIZE`             | no       | Default `50`. |
| `CLAIM_INTERVAL_MS`            | no       | Default `5000`. |
| `HEARTBEAT_INTERVAL_MS`        | no       | Default `60000`. |
| `MAX_CONCURRENCY`              | no       | Default `10`. |
| `PER_DOMAIN_DELAY_MS`          | no       | Default `5000`. |
| `MAX_RETRIES`                  | no       | Default `3`. |

See `.env.example` for a copy-pasteable starter.

---

## Deploy to Railway

### 1. Push this repo to GitHub

Create a new GitHub repo called `tlbg-verifier-worker` and push the
contents of this folder to it. Nothing else should live in the repo —
this worker is intentionally separated from the main TLBG platform repo.

### 2. Create the engine service

In your Railway project click **+ New → Docker Image** and use:

```
ghcr.io/aftership/email-verifier:latest
```

Name it `email-verifier`. Expose port `8080` on Railway private networking.
No public domain is needed.

> ⚠️ Many cloud providers (Railway included) block outbound port 25.
> If verification responses come back as `unknown`, you'll need an SMTP
> egress proxy or a provider that allows port 25.

### 3. Create the worker service

Click **+ New → GitHub Repo** and pick `tlbg-verifier-worker`. Railway
will detect the `Dockerfile` and `railway.json` automatically.

Set the following service variables:

```
SUPABASE_WORKER_API_URL=https://YOUR-PROJECT.supabase.co/functions/v1/verification-worker-api
VERIFICATION_WORKER_SECRET=<paste the same value configured on the platform>
VERIFIER_URL=http://email-verifier.railway.internal:8080
WORKER_ID=railway-worker-1
VERIFIER_ENGINE=aftership-email-verifier
VERIFIER_VERSION=1.7.2
```

(Use Railway **private networking** for `VERIFIER_URL` — the
`email-verifier.railway.internal` hostname is auto-created when both
services share a project.)

### 4. Verify

Within ~60 seconds the worker should:

1. Appear in the platform's **Verification → Engines Registry** as `online`.
2. Start claiming jobs and posting results to `/submit`.

The platform's **Verification → API Management** page exposes
`/health` and a checklist that flips to ✅ once the worker is connected.

---

## Run locally (docker-compose)

```bash
cp .env.example .env
# edit .env: set SUPABASE_WORKER_API_URL + VERIFICATION_WORKER_SECRET
docker compose up --build
```

This starts both the AfterShip engine container and the worker.

---

## Run locally without Docker

```bash
npm install
export SUPABASE_WORKER_API_URL=...
export VERIFICATION_WORKER_SECRET=...
export VERIFIER_URL=http://localhost:8080   # your engine
node worker.mjs
```

---

## How the worker talks to the platform

All calls are `POST` with `x-worker-secret: <shared secret>` and
`content-type: application/json`.

| Endpoint        | When | Payload |
|-----------------|------|---------|
| `/claim`        | Continuously | `{ limit }` → returns `{ batch: [...] }` |
| `/quota`        | Per workspace per batch | `{ workspace_id, consume: true, count }` |
| `/submit`       | After successful verification | Canonical result object |
| `/fail`         | After transient failure | `{ result_id, error }` |
| `/dead-letter`  | After permanent failure / quota block | `{ workspace_id, result_id, email, reason, ... }` |
| `/heartbeat`    | Every `HEARTBEAT_INTERVAL_MS` | Worker status + metrics |
| `/health`       | Optional GET | Liveness probe |

The platform applies workspace scoping, rules, suppression, and
attribution downstream of `/submit`. The worker only verifies and
reports.

---

## Engines

- **Default**: [AfterShip email-verifier](https://github.com/AfterShip/email-verifier) — MIT licensed.
- **Alternative**: [truemail-go](https://github.com/truemail-rb/truemail-go) — also OSS.
- **Reacher**: only after confirming licensing. Do not enable by default.

To swap engines, replace the `verifyEmail()` adapter in `worker.mjs`
and update `VERIFIER_ENGINE` / `VERIFIER_VERSION`.

---

## Security

- The shared secret is the only authentication boundary. Treat it as a
  production credential.
- Never log the secret. Never expose it client-side.
- Rotate by updating the platform secret and the worker env var in
  the same window.
