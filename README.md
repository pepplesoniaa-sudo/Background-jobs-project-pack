# Background Jobs Project Pack

A background job system that sends email **off the web request path**. A request
writes one job row and returns immediately; a separate worker sends the email,
retries when it should, stops when it should, and leaves a record that proves
what happened to every job.

- **Stack:** TypeScript, Node.js, Fastify, raw SQL via `pg`, Postgres, nodemailer.
- **Delivery model:** at-least-once, *made safe* — not exactly-once. See
  [Known limits](#known-limits).

The full specification lives in [`Background_Jobs_Project_Pack.md`](Background_Jobs_Project_Pack.md)
(PRD, rules, skills) and [`docs/PRD-CHANGES.md`](docs/PRD-CHANGES.md) (implementation
decisions and deviations).

## Architecture

Two long-running processes share one Postgres database:

| Process | Entry point | Role |
|---|---|---|
| Web app | `src/main.ts` | Enqueues jobs, reports status, serves the home page and the admin dead-letter page |
| Worker | `src/workerMain.ts` | Claims jobs atomically, sends email, retries, sweeps stuck jobs |

```
client ──POST /api/jobs──▶ web app ──INSERT──▶ jobs (pending)
                                                  │
                          worker ──claim (FOR UPDATE SKIP LOCKED)──▶ processing
                                                  │
                        send OK ──────────────────┼──────────────▶ succeeded
                        retryable error ──────────┤──▶ failed (run_at = now + backoff)
                        retries used up / permanent┴──────────────▶ dead  ──▶ admin review
```

Every worker also runs a **sweep** that recovers jobs whose lock has gone stale
(worker crash, kill, hang) through the same fail-or-retry path.

## Data model

Three tables (see [`migrations/`](migrations)):

- **`jobs`** — one row per job. `status` ∈ `pending, processing, succeeded, failed, dead`.
  `idempotency_key` is `UNIQUE`. Indexed on `(status, run_at)`.
- **`job_attempts`** — attempt history, `UNIQUE (job_id, attempt_no)`, stores the
  backoff `bound` and `delay` for each try.
- **`sent_emails`** — one row per job, `state` ∈ `sending, sent`; the basis for
  sending safely when a job runs twice.

### Status meanings

| Status | Meaning |
|---|---|
| `pending` | New, never started |
| `processing` | A worker holds it (`locked_by` is set) |
| `failed` | Last attempt failed and it **will be retried**; `run_at` is in the future |
| `succeeded` | Finished (the mail server *accepted* the message) |
| `dead` | Retries used up, or a permanent error. **A human must act.** |

`attempts` is incremented **when a job is claimed**, not when it fails — so a
worker crash counts as an attempt automatically.

## Requirements

- Node.js 22+ (uses `--env-file` and `--import tsx`)
- Docker (for the Postgres container) or any Postgres 13+ instance
  (`gen_random_uuid()`; the claim query uses `WITH ... MATERIALIZED`, Postgres 12+)

## Setup

1. **Install dependencies**

   ```sh
   npm install
   ```

2. **Configure environment.** Copy the names from `.env.example` into `.env` and
   fill in real values. `.env` is git-ignored and must never be committed.

   ```sh
   cp .env.example .env
   ```

   Required at minimum: `DATABASE_URL`, `MAX_ATTEMPTS`, `PORT`, and (for the web
   app) a `ADMIN_TOKEN` of at least 16 characters. The worker additionally needs
   the config keys listed below.

3. **Start Postgres** (uses `POSTGRES_PASSWORD` from `.env`):

   ```sh
   docker compose up -d db
   ```

4. **Apply migrations** (there is no migration runner):

   ```sh
   docker exec -i bgjobs-pg psql -U jobs -d jobs_dev \
     < migrations/001_create_jobs_tables.sql
   docker exec -i bgjobs-pg psql -U jobs -d jobs_dev \
     < migrations/002_job_attempts_worker_id_not_null.sql
   ```

5. **Run the web app and the worker** in two terminals:

   ```sh
   npm run web
   npm run worker
   ```

   Open <http://127.0.0.1:3000> to queue a test email and watch its status.
   The dead-letter view is at <http://127.0.0.1:3000/admin/dead>.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run web` | Start the web app (loads `.env`) |
| `npm run worker` | Start the worker (loads `.env`) |
| `npm test` | Run the vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `docker compose up -d db` | Start the Postgres container |

## Configuration

All values are read from the environment and validated at startup. Secrets
(`DATABASE_URL`, `ADMIN_TOKEN`, `EMAIL_PASSWORD`) live **only** in the
environment — never in code, tests, README, logs or commit messages.

| Key | Default | Used by | Notes |
|---|---|---|---|
| `DATABASE_URL` | — | both | Postgres connection string (secret) |
| `PORT` | — | web | HTTP port |
| `ADMIN_TOKEN` | — | web | Guards `/api/admin/*`; min 16 chars (secret) |
| `MAX_ATTEMPTS` | 5 | both | Copied into each job at enqueue |
| `MAIL_TRANSPORT` | `fake` | worker | `fake` or `real` |
| `UNCERTAIN_SEND_POLICY` | — | worker | `resend` or `flag_for_human` |
| `WORKER_CONCURRENCY` | 5 | worker | Max jobs in flight per worker process |
| `POLL_INTERVAL_MS` | 1000 | worker | Idle poll interval |
| `BACKOFF_BASE_MS` | 2000 | worker | Backoff base |
| `BACKOFF_CAP_MS` | 300000 | worker | Backoff cap |
| `SEND_TIMEOUT_MS` | 30000 | worker | Send timeout |
| `STUCK_TIMEOUT_MS` | 120000 | worker | Sweep reclaims locks older than this |
| `SWEEP_INTERVAL_MS` | 15000 | worker | Sweep period |
| `HEARTBEAT_INTERVAL_MS` | 10000 | worker | Lock refresh period for a running job |
| `FAKE_SEND_DELAY_MS` | 0 | worker | Fake transport sleep; must be below `SEND_TIMEOUT_MS` |
| `FORCE_FAIL` | false | worker | Fake transport always returns a retryable 503 |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_USER` / `EMAIL_PASSWORD` / `EMAIL_FROM` | — | worker | Only for `MAIL_TRANSPORT=real` |

**Startup checks (the worker refuses to start otherwise):**

- `STUCK_TIMEOUT_MS >= 3 * SEND_TIMEOUT_MS`
- `STUCK_TIMEOUT_MS >= 3 * HEARTBEAT_INTERVAL_MS`
- `FAKE_SEND_DELAY_MS < SEND_TIMEOUT_MS`
- `BACKOFF_CAP_MS >= BACKOFF_BASE_MS`

## How it works

- **Enqueue** (`POST /api/jobs`) inserts one `pending` row with
  `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`, then reads the existing
  row if there was a conflict. Same key + same owner + same payload → `200` with
  the existing job; different payload or owner → `409`; new → `202`. Uniqueness is
  enforced by the database constraint, never by checking first.
- **Claim** is a single statement using `FOR UPDATE SKIP LOCKED` and the database
  clock, so two workers can never take the same job.
- **Retry vs dead** is decided by one function (`src/failOrRetry.ts`) shared by the
  worker and the sweep. Permanent errors go straight to `dead`. Equal-jitter
  backoff lives in one place (`src/backoff.ts`).
- **Safe sending** (`src/sendEmail.ts`) claims the `sent_emails` row before
  sending. A known refusal (4xx) deletes the row; an unknown outcome (timeout,
  dropped connection, 5xx) leaves it `sending` and applies
  `UNCERTAIN_SEND_POLICY`. Under `flag_for_human` the job dies as `uncertain send`
  for a human to resolve.
- **Guarded writes:** every final update is `WHERE status = 'processing' AND
  locked_by = <this worker>`. Zero rows changed means the worker lost the job —
  it discards the result and logs one warning.
- **Heartbeat** refreshes `locked_at` while a job runs, so a slow-but-alive job is
  never mistaken for stuck. The **sweep** recovers jobs whose lock went stale.
- **Traceability:** emails carry `X-Job-Ref`, a one-way label (first 20 hex of
  `SHA-256(job id)`), instead of the raw job id.

## API

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/jobs` | `x-user-id` header | Enqueue; `202` new / `200` existing / `409` conflict / `400` bad recipient |
| `GET /api/jobs/:id` | `x-user-id` header | Status for the owner only; anyone else gets `404` |
| `GET /admin/dead` | none (page only, holds no data) | Dead-letter page |
| `GET /api/admin/dead-jobs` | `x-admin-token` header | List dead jobs with attempt history |
| `POST /api/admin/dead-jobs/:id/retry` | `x-admin-token` header | Retry a dead job (fresh attempt allowance; history kept) |
| `POST /api/admin/dead-jobs/:id/mark-not-sent` | `x-admin-token` header | Clear an unknown-outcome `sending` row so a retry can send |
| `POST /api/admin/dead-jobs/:id/mark-sent` | `x-admin-token` header | Operator confirmed the email went out: `dead → succeeded` |

## Tests

Tests use **real Postgres** and real HTTP; there are no database mocks. DB tests
refuse to connect to any database not named `jobs_test`
(`test/guard.setup.ts`) and only touch rows with a known key prefix.

Because the DB guard requires `jobs_test`, the test run must point
`DATABASE_URL` at it. An environment variable already set takes precedence over
`--env-file`, so override it at run time.

```sh
# 1. Create the test database (once)
docker exec bgjobs-pg psql -U jobs -d jobs_dev -c "CREATE DATABASE jobs_test;"
docker exec -i bgjobs-pg psql -U jobs -d jobs_test < migrations/001_create_jobs_tables.sql
docker exec -i bgjobs-pg psql -U jobs -d jobs_test < migrations/002_job_attempts_worker_id_not_null.sql

# 2. Run the suite against jobs_test
#    PowerShell:
$env:DATABASE_URL="postgresql://jobs:PASSWORD@127.0.0.1:5433/jobs_test"; npm test
#    bash:
DATABASE_URL="postgresql://jobs:PASSWORD@127.0.0.1:5433/jobs_test" npm test
```

The suite covers enqueue/idempotency, atomic claims, concurrency cap, failure and
backoff, the sweep, heartbeats, lost-job handling, graceful shutdown, the SMTP
error classifier, traceability, and the admin page.

> **Timing-sensitive tests.** A few tests use very short windows (a 25–50 ms
> backoff, or assert the DB pool never queues). Over a slow/high-latency database
> — for example Docker Desktop port-forwarding on Windows — they can fail
> spuriously. Run against a local Postgres for stable results.

## Security notes

- Secrets are environment-only. `.env` is git-ignored and `.env.example` lists
  names with empty values.
- Recipient addresses, payloads, tokens and keys are **never logged** and never
  appear in the status response. Error messages are short and address-free.
- The admin token travels in the `x-admin-token` **header only** — never a URL,
  cookie or storage. Both pages use a strict Content Security Policy and insert
  server text with `textContent` only.
- The `x-user-id` owner check is demo-level: a header can be faked. The real
  barrier is that job ids are random UUIDs. This prevents accidents, not attackers.
- `succeeded` means the mail server **accepted** the message; it does not confirm
  delivery. Bounces that arrive later are invisible to the system.

## Known limits

- **At-least-once, not exactly-once.** SMTP has no idempotency key. When a send's
  outcome is unknown, the system chooses between a possible duplicate (`resend`)
  and a possible missed email needing a human (`flag_for_human`). It runs with
  `flag_for_human`.
- Bounces are invisible — an accepted-then-bounced message still shows as
  `succeeded`.
- The admin token has no attempt limit.
- On Windows only Ctrl+C / Ctrl+Break deliver a graceful stop; `Stop-Process`,
  `taskkill /F` and `process.kill` are hard kills. The sweep exists for exactly
  that case.

## Project layout

```
src/
  main.ts / server.ts        web app: enqueue, status, pages
  adminRoutes.ts / adminPage.ts  dead-letter API and page
  homePage.ts                queue + status UI
  workerMain.ts              worker entry: config, pool, sweep, shutdown
  workerLoop.ts              concurrency cap and loop
  worker.ts                  claim, process, finish
  sendEmail.ts / transport.ts / smtpTransport.ts  safe send + transports
  failOrRetry.ts / backoff.ts / sweep.ts / ownership.ts  retry machinery
  enqueue.ts / config.ts / recipient.ts / mask.ts / messageId.ts  supporting
migrations/                  SQL schema (applied in order)
test/                        vitest suite + fake SMTP server
scripts/e2e/enqueue.js       evidence helper that posts real jobs
docs/PRD-CHANGES.md          implementation decisions and deviations
```
