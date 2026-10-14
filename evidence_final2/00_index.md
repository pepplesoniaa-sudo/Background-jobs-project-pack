# Evidence pack 2 - background jobs (Task 2, fresh run)

All outputs here were produced against the **jobs_evidence** database only, with the **fake** mail
transport (`transport=fake` is printed in every worker log). Nothing was sent by real email.
**jobs_dev** was read once at the start and once at the end (count only) and was **not** touched.
No source, migration or existing test file was edited. No git commit or push was run.

Every claim is labelled **CONFIRMED** (the command was run and its output is saved here) or
**INFERRED** (a reading of the code, not executed).

## How each run was pointed at jobs_evidence / jobs_test (secret-safe)
`.env` holds the real DATABASE_URL (which points at jobs_dev) and the Gmail settings. For every
evidence run the database name is rewritten to `jobs_evidence` and `MAIL_TRANSPORT` is forced to
`fake` (`_helpers/env.ps1`). For the test suite the name is rewritten to `jobs_test`
(`_helpers/env-test.ps1`). The password and the ADMIN_TOKEN are never printed or saved. Node's rule
(shell env beats `--env-file=.env`) makes the override work.

## What was here before the run (CONFIRMED)
- `jobs_evidence` before the run: **dead 6, succeeded 109** (all terminal; no runnable rows).
- `jobs_dev` total = **14 jobs / 14 job_attempts / 14 sent_emails**. Re-checked at the end: still
  **14 / 14 / 14**, unchanged.
- This run uses the `evid3-` key prefix. The earlier pack (`evidence_final/`) used `evid2-`; those
  rows are untouched and still present.

## Files in this folder
| File | What it shows |
|------|----------------|
| `00_schema.txt` | `jobs`, `job_attempts`, `sent_emails` schema + constraints |
| `test_output.txt` | full `vitest run` result (20 files, 320 pass / 1 flaky) |
| `sweep_rerun_1..3.txt` | the one flaky test re-run 3x, all pass |
| `item1_all_statuses.txt` | the jobs table with one fresh job in **every** status |
| `item2_backoff.txt` | retry delay growing attempt over attempt |
| `item3_concurrency.txt` | 50 jobs, concurrency cap of 5 holds |
| `item4_stuck_recovery.txt` | a killed mid-send job: stuck -> recovered -> finished |
| `item5_deadletter.txt` | the dead-letter view with >= 1 job (masked recipient) |
| `item5_dead_jobs_api.json` | raw body of GET /api/admin/dead-jobs |
| `admin_dead_page.html` | the served dead-letter HTML page |
| `*_stdout.txt`, `*-worker.log` | raw stdout / worker stdout (shows `transport=fake`, `max_seen`) |
| `_helpers\` | the scripts used; `start-web.ps1` starts the web app for the item-5 screenshot |

## Test suite result (CONFIRMED)
`test_output.txt` (run once, against `jobs_test`):
`Test Files 1 failed | 19 passed (20)` / `Tests 1 failed | 320 passed (321)`.
The single failure is `sweep.test.ts > recovers a stuck job to failed with backoff, and closes its
attempt row` (assertion `run_at > now()`, sweep.test.ts:93). The backoff in that test is only
25-50 ms, so the assertion is timing-sensitive. Re-run in isolation 3 times: **13/13 passed each
time** (`sweep_rerun_1..3.txt`). Judged **flaky (timing)**, not a product defect.

## Item 1 - jobs in every status (CONFIRMED)
`item1_all_statuses.txt`. Five jobs created fresh through the real API/worker paths (no rows edited),
one per status, captured in a single snapshot:

| key | status | attempts | note |
|-----|--------|----------|------|
| succ | succeeded | 1/5 | normal send accepted by the fake transport |
| dead | dead | 2/5 | fake provider failed; `flag_for_human` stopped the 2nd try as "uncertain send" |
| failed | failed | 1/5 | one retryable failure, `run_at` pushed into the future by backoff |
| proc | processing | 1/5 | worker alive, mid-send (locked_by set) |
| pend | pending | 0/5 | waiting behind the single busy worker |

`STATUS COUNTS: {"succeeded":1,"dead":1,"failed":1,"processing":1,"pending":1}` -> has all five: **true**.
The `processing` and `pending` jobs are captured in the same instant by running one worker with
concurrency 1 that is busy sending the `processing` job.

## Item 2 - retry delays grow (CONFIRMED)
`item2_backoff.txt`. One job forced to fail on every attempt under `resend` policy.

| attempt | backoff_bound_ms | delay_ms | gap from previous finish (ms) |
|---------|------------------|----------|-------------------------------|
| 1 | 2000 | 1928 | - |
| 2 | 4000 | 3717 | 1995 |
| 3 | 8000 | 4293 | 3717 |
| 4 | 16000 | 11632 | 4297 |
| 5 | - | - | 11657 (attempts 5/5 -> dead) |

Bound doubles each attempt (`base * 2^(n-1)`); the real delay sits in `[bound/2, bound)` (equal
jitter) and grows with it. Result: status=dead, attempts=5/5.

## Item 3 - concurrency cap holds under 50 jobs (CONFIRMED)
`item3_concurrency.txt`. 50 jobs, one worker with `WORKER_CONCURRENCY=5`, each fake send 800 ms.
- samples = 45, `MAX_CONCURRENT_PROCESSING_SEEN = 5`, samples exactly at the cap = 38.
- the worker's own log line `max_seen=5`.
- all 50 ended succeeded (113 -> 163 succeeded).

The cap was never exceeded.

## Item 4 - stuck job recovery (CONFIRMED)
`item4_stuck_recovery.txt`. A worker was **hard-killed** mid-send (on Windows `Stop-Process` is a
hard kill; signal handlers do not run). The one job went through three states:
- **State 1 (stuck processing):** `status=processing`, `locked_by=DESKTOP-UTKAUV9-43320` (dead worker),
  `locked_at` frozen, `sent_emails.state=sending` (unknown outcome).
- **State 2 (recovered):** after the lock aged past `STUCK_TIMEOUT_MS=6000`, a second worker's sweep
  set it to `failed` with `last_error="stuck: worker lost or slow"` and a future `run_at`.
- **State 3 (finished):** retried under `resend` -> `succeeded`, `attempts=2`, `sent_emails.state=sent`.

## Item 5 - dead-letter view with >= 1 job (CONFIRMED)
`item5_deadletter.txt`, `item5_dead_jobs_api.json`, `admin_dead_page.html`. A fresh job was driven to
`dead`, then the admin route was read with the token from `.env` (used, never printed):
`GET /api/admin/dead-jobs` -> HTTP 200, total dead = 9. The new job appears with the recipient
**masked** (`d***@example.invalid`), its subject, its `jobRef`, the "email state: sending / outcome
UNKNOWN" warning (`checkProviderBeforeRetry: true`), and its attempt history. `GET /admin/dead` ->
HTTP 200 (page saved).

### Item 5 screenshot - your steps
1. In a terminal in the project folder, run:
   `& ".\evidence_final2\_helpers\start-web.ps1"`
   (starts the app on http://127.0.0.1:3200 against jobs_evidence with the fake transport; Ctrl+C stops it).
2. Open **http://127.0.0.1:3200/admin/dead** in a browser.
3. In the "Admin token" box paste the value of `ADMIN_TOKEN` from `.env`; click **Load**.
4. Screenshot the table (it lists the 9 dead jobs, recipient masked).

## Notes / limits
- Items 1-5 were produced by building the real app in-process and calling its routes via Fastify
  `inject` (same handlers, same enqueue/validation code, no network port). The standalone server used
  for the screenshot is the identical `src/main.ts`.
- A separate service already owned TCP port 3000 on this machine, so the project's own default of
  3200 was used for the web app. Nothing outside this project was changed.
- The `processing` job for item 1 and the killed job for item 4 leave a `sent_emails` row in state
  `sending`; that is the intended "outcome unknown" behaviour, not a defect.
