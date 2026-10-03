# Background Jobs Project Pack

PRD, rules, skills and AGENTS.md in one file. Job type: sending email.

## Read this first

- **What this is.** Four files for your coding agent in one document. Each file below is a section. Save each under the name in its heading.
- **What is confirmed and what is guessed.** I have not seen your repo, stack or mail provider. Anything that depends on them is marked CONFIRM or INFERRED. Five decisions (D1 to D5, in the PRD) must be settled before step 1.
- **Order of use.** Save the four files in the repo root. Then paste the Step 1 prompt from Part 5. Do not hand the agent the whole project at once.
- **Where this pack departs from the brief, on purpose.** (1) The attempt count goes up when a job is claimed, not when it fails, so a crash is counted automatically. (2) `failed` is a real stored status meaning "will retry", so your screenshot can show every status. (3) A repeat of the same key returns 200 with the existing job, and a new job returns 202. (4) Retry delays use "equal jitter" so growth stays visible in your evidence. (5) A manual retry grants a fresh allowance of attempts instead of resetting the count.

| Part | Save as | What it is for | Who reads it |
|---|---|---|---|
| 1 | PRD.md | What is being built, the data model, the status rules, the tests | Agent and you |
| 2 | RULES.md | How the agent must behave, including the secrets rule | Agent |
| 3 | SKILLS.md | Step-by-step procedures: claim, retry, sweep, safe send, tests | Agent |
| 4 | AGENTS.md | Short entry file the agent reads first | Agent |
| 5 | (prompt) | The first prompt to give the agent: schema only | You paste it |
| 6 | (audit) | What I checked, what I found, what is still open | You |

---

# Part 1: PRD.md

Save as `PRD.md`. Section 4 (decisions you owe) and section 9 (the six tests) matter most.

### BACKGROUND JOB SYSTEM: EMAIL SENDING

```text
Version 1.0. Ready for step 1 once section 4 (Decisions) is confirmed.
```

### 1. PURPOSE

```text
Move email sending out of the web request. A request writes a job row and returns at once.
A separate worker sends the email, retries when it should, stops retrying when it should,
and leaves a record that proves what happened to every job.
```

### 2. USERS

```text
- Client app: creates a job, then polls for the result.
- Operator (Rox): watches the dead letter view and retries dead jobs by hand.
- Reviewer: reads the evidence and the write-up and decides whether the queue is real.
```

### 3. NON-GOALS

```text
No landing page. No login system beyond identifying a caller. No interface beyond a trigger
form, a status view and the dead letter view. No claim of "exactly once" delivery.
```

### 4. DECISIONS (defaults below are INFERRED, not confirmed. Settle before step 1.)

```text
D1 Stack. Default: TypeScript and Postgres. CONFIRM language and ORM. If the ORM cannot
   return a row from a single UPDATE, the claim query uses raw SQL.
D2 Worker host. A separate long-running process. NOT Vercel functions (they are short-lived).
   CONFIRM: local only, or a small always-on host.
D3 Mail provider. CONFIRM from its own docs: (a) accepts an idempotency key, (b) how long
   the key is remembered, (c) sender verification needed, (d) free-tier rate limit.
D4 Uncertain-send policy. resend ONLY if D3(a) is confirmed AND D3(b) shows the key outlives
   the retry window (backoff, sweep, and any manual retry you expect). Otherwise flag_for_human.
D5 Concurrency N, per worker process. Default 5. Must stay under the provider rate limit.
```

### 5. DATA MODEL (snake_case in the database)

```text
jobs
  id                 uuid, primary key, random
  type               text                    ("send_email")
  owner_id           text                    who enqueued it
  payload            jsonb
  payload_hash       text                    for the same-key-different-payload check
  status             text, CHECK in (pending, processing, succeeded, failed, dead)
  attempts           int, default 0          times STARTED, not times failed
  max_attempts       int                     copied from config at enqueue
  last_error         text                    short, no personal data
  run_at             timestamptz             earliest next claim time
  locked_by          text                    worker id
  locked_at          timestamptz
  started_at         timestamptz
  finished_at        timestamptz
  idempotency_key    text, NOT NULL, UNIQUE
  created_at         timestamptz, default now()
  index on (status, run_at)

job_attempts
  id, job_id (foreign key), attempt_no, worker_id, started_at, finished_at, error,
  backoff_bound_ms, delay_ms
  UNIQUE (job_id, attempt_no)

sent_emails
  job_id (primary key, one row per job), state (sending | sent), provider_message_id,
  created_at, updated_at
```

### 6. STATUS MEANINGS AND TRANSITIONS

```text
pending     new, never started
processing  a worker holds it (locked_by is set)
failed      last attempt failed, WILL be retried, run_at is in the future
succeeded   finished
dead        retries used up, or a permanent error. A human must act.

Allowed transitions, and no others:
  enqueue                                          -> pending
  claim (pending or failed, run_at <= now())       -> processing, attempts + 1
  work succeeds                                    -> succeeded
  retryable error, attempts < max_attempts         -> failed, run_at = now() + backoff
  retryable error, attempts >= max_attempts        -> dead
  permanent error                                  -> dead
  sweep finds stuck job, attempts < max_attempts   -> failed, with backoff
  sweep finds stuck job, attempts >= max_attempts  -> dead
  manual retry (dead only)                         -> pending, run_at = now(),
                                                      max_attempts = attempts + MAX_ATTEMPTS

DEVIATION FROM THE BRIEF: attempts goes up when a job is CLAIMED, not when it fails.
A worker crash then counts as an attempt automatically, so the sweep cannot forget to count it.
```

### 7. REQUIREMENTS (each has a test in section 9)

```text
FR1  Enqueue. POST /api/jobs writes one pending row and returns 202 with the job id. It
     never sends mail and never waits. The caller is identified by the x-user-id header
     (demo-level only). The field is idempotencyKey in the API and idempotency_key in the
     database. Keep both names as they are.
     Same key, same owner, same payload again: 200 with the existing job. Same key with a
     different payload or owner: 409.
FR2  The idempotency key is enforced by the database UNIQUE constraint. Use insert with
     ON CONFLICT DO NOTHING, then read the existing row. Never check first and insert second.
FR3  Claim is ONE statement, uses FOR UPDATE SKIP LOCKED and the database clock.
FR4  Every final update (succeeded, failed, dead) includes
     WHERE status = 'processing' AND locked_by = <this worker>. Zero rows updated means the
     worker lost the job: throw the result away and log a warning.
FR5  At most N jobs run at once per worker process. The running count is logged.
FR6  Errors are sorted into two kinds.
     Retryable: timeout, network error, 5xx, 429.
     Permanent: invalid address, rejected content, any other 4xx.
     Permanent goes straight to dead.
FR7  Backoff (equal jitter), in ONE function:
       bound = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^(attempts - 1))
       delay = bound / 2 + random(0, bound / 2)
     Store bound and delay on the attempt row so growth is visible.
FR8  Running a job twice sends one email. Uses sent_emails and the job id as the provider
     idempotency key. See SKILLS: send-email-safely.
FR9  Sweep runs every SWEEP_INTERVAL_MS. Jobs in processing with locked_at older than
     STUCK_TIMEOUT_MS go through the same fail-or-retry function as FR6. The worker refuses
     to start if STUCK_TIMEOUT_MS < 3 * SEND_TIMEOUT_MS.
FR10 Dead letter view (admin only): lists dead jobs with id, type, created time, attempts,
     last_error, full attempt history, and the payload with the recipient masked. A retry
     button sends a POST. Retry only acts on rows that are currently dead. Retry does NOT
     reset attempts. It gives a fresh allowance: max_attempts = attempts + MAX_ATTEMPTS.
     Reason: job_attempts is UNIQUE on (job_id, attempt_no) and history must be kept.
     The view also shows the sent_emails state. If it is "sending", the outcome of the last
     try is UNKNOWN: the retry button must warn "check the provider before retrying".
FR11 GET /api/jobs/:id returns id, status, attempts, max_attempts, run_at, finished_at and a
     safe error. Only the owner can read it. Anyone else gets 404.
FR12 Dead letter routes require ADMIN_TOKEN from the environment. Never in a URL.
FR13 Payload bodies, recipient addresses, tokens and keys never appear in logs or in the
     status response (NDPA 2023).
FR14 Every number in this document comes from config and is validated at startup. The
     worker refuses to start if STUCK_TIMEOUT_MS < 3 * SEND_TIMEOUT_MS, or if
     FAKE_SEND_DELAY_MS >= SEND_TIMEOUT_MS (the send would time out instead of hanging).
```

### 8. CONFIG

```text
WORKER_CONCURRENCY     5         per worker process
POLL_INTERVAL_MS       1000
MAX_ATTEMPTS           5
BACKOFF_BASE_MS        2000
BACKOFF_CAP_MS         300000
SEND_TIMEOUT_MS        30000
STUCK_TIMEOUT_MS       120000    at least 3 * SEND_TIMEOUT_MS
SWEEP_INTERVAL_MS      15000
UNCERTAIN_SEND_POLICY  resend | flag_for_human     (see D4)
MAIL_TRANSPORT         fake | real                 default fake
FAKE_SEND_DELAY_MS     0         raise for T1 and T3. Must stay below SEND_TIMEOUT_MS
FORCE_FAIL             false     true makes every send throw a retryable 503
DATABASE_URL, MAIL_API_KEY, ADMIN_TOKEN   SECRETS. Environment only. Never in files that
                                          reach GitHub or Vercel.
```

### 9. BREAK-IT TESTS (all six must be recorded)

```text
T1 Concurrency cap. 50 jobs at once, FAKE_SEND_DELAY_MS=1000.
   Pass: logged concurrent count never exceeds N. All 50 succeed.
   Evidence: log excerpt with concurrent counts and a final max_concurrent line.
T2 Total failure. FORCE_FAIL=true, one job.
   Pass: job shows failed between tries, then dead at MAX_ATTEMPTS. Each delay is between
   half its bound and its bound, and bounds double.
   Expect 5 attempts and 4 delays (the fifth failure goes straight to dead).
   Evidence: job_attempts rows (attempt_no, backoff_bound_ms, delay_ms, timestamps).
T3 Killed worker. Raise FAKE_SEND_DELAY_MS, lower SEND_TIMEOUT_MS and STUCK_TIMEOUT_MS
   together (keep the 3x rule). Start a job, run kill -9 on the worker mid-send, restart.
   Pass: job stays processing after the kill, the sweep recovers it, it later succeeds,
   the fake mailbox holds one message. This needs UNCERTAIN_SEND_POLICY=resend. Under
   flag_for_human the correct result is dead with "uncertain send". Record whichever applies.
   Evidence: three screenshots (before kill, after kill, after recovery).
T4 Duplicate key. Send the same key twice in a row, then 20 requests at the same instant,
   then the same key with a different payload.
   Pass: exactly one row, same id returned each time, the different payload gets 409.
T5 Two workers. Run two workers, 50 jobs.
   Pass: no job claimed twice (job_attempts UNIQUE would reject it), each job has one
   successful attempt, the fake mailbox holds each job id once, each worker stays within N.
T6 Double run. Call the send function twice for one job. Then once more with the
   sent_emails row left in sending state (policy resend; under flag_for_human expect an
   "uncertain send" error).
   Pass: the fake mailbox shows one message for that key.
   Honest limit: this proves OUR code. It does not prove the real provider dedupes.
   Also do one real send at step 8 and say so in the write-up.
```

### 10. EVIDENCE CHECKLIST

```text
- Jobs table showing every status: pending, processing, failed, succeeded, dead.
  They do not appear together by accident. See SKILLS: status-snapshot.
- Backoff rows from T2.
- Concurrency log from T1.
- Three stuck-job screenshots from T3.
- Dead letter view with at least one job.
- Results of T1 to T6, written down. Recipient addresses blurred or fake.
```

### 11. BUILD ORDER (one step at a time. Each step must be verified before the next.)

```text
S1 Schema only (three tables, constraints, index).
S2 Enqueue and idempotency, with T4.
S3 One worker: atomic claim, guarded finish, fake transport, happy path, with T6.
S4 Failure handling, backoff, dead state, with T2.
S5 Sweep, with T3.
S6 Concurrency cap and logging (T1), then second worker (T5).
S7 Dead letter view, manual retry (test: a retried job runs and attempt numbers continue),
   status endpoint, admin gate.
S8 One real send, evidence collection, write-up.
```

### 12. RISKS

```text
- Provider idempotency keys expire. Total retry window (backoff cap x MAX_ATTEMPTS) must be
  shorter than the key lifetime from D3(b).
- flag_for_human turns every timeout and 5xx into a human task. Accept that, or pick a provider
  that supports idempotency keys.
- A crash between writing the sending row and calling the provider looks like an uncertain
  send. Under flag_for_human that is a false alarm. Accepted.
- A manual retry days later can outlive the provider's key. If sent_emails says "sending",
  retrying may send a second copy. That is why FR10 warns the operator.
- Client keys should be random UUIDs so one user cannot guess another's key.
- The owner check is only as strong as how the caller is identified. A header can be faked.
  For this project it prevents accidents, not attackers. The real barrier is that job ids
  are random UUIDs. Say this plainly in the write-up.
```

### 13. DONE WHEN

```text
All FR1 to FR14 have a passing test, T1 to T6 are recorded with evidence, and the write-up
says "at least once, made safe", not "exactly once".
```


---

# Part 2: RULES.md

Save as `RULES.md`. Rule 1 is your standing secrets rule. The step report at the end forces the agent to separate what it proved from what it assumed.

```text
Rules for the coding agent. These override convenience.
If a rule and a request conflict, stop and ask.
```

### SECURITY (highest priority)

```text
1. Never add secrets or secret keys to the README or anywhere in the project that gets sent
   to GitHub or Vercel. That covers code, comments, tests, example files, screenshots, logs
   and commit messages.
2. Secrets live only in environment variables. .env is git-ignored BEFORE the first commit.
   .env.example lists names only, with empty values.
3. Run SKILLS: pre-commit-check before every commit. If it finds anything, stop and report.
4. Never log recipient addresses, email bodies, payloads, tokens or keys. Log job id, type,
   status, attempt number and worker id only.
5. Test only with addresses the owner controls.
```

### HOW TO WORK

```text
6. Follow PRD section 11 in order. Do not start a step until the owner says the last one is
   verified. A schema change and a behaviour change never share a step.
7. Show evidence, not summaries. Paste real command output or the diff. "It works" with no
   output counts as not done.
8. Label every claim CONFIRMED (you ran it, output pasted) or INFERRED (you reasoned it).
9. If a requirement is unclear or two requirements conflict, stop and ask. Do not choose
   silently.
10. No new dependency, table or config key without asking first.
11. Never edit a migration that has been applied. Add a new one.
12. Never weaken or delete a test to make it pass. If you think a test is wrong, say why
    and ask.
13. Stay inside the current step. Do not tidy or refactor other files.
14. Never run destructive commands against a database you were not told is local or dev.
```

### DATABASE

```text
15. The claim is one statement with FOR UPDATE SKIP LOCKED. Never read then write.
16. Every final update is guarded: WHERE status = 'processing' AND locked_by = me.
    Zero rows changed means the job was lost. Discard the result and log a warning.
17. Use the database clock (now()) for run_at, locked_at and the sweep. Never a worker clock.
18. Uniqueness is enforced by constraints, not by checking first.
```

### JOB RULES

```text
19. failed means "will retry". dead means "a human must act". Never mix them up.
20. attempts goes up at claim time, never at failure time.
21. One function decides failed versus dead. The worker and the sweep both call it.
22. One function computes backoff, with the jitter on a single obvious line. No other
    code computes delays.
23. No number hardcoded. Delays, limits, timeouts and counts come from config.
24. Permanent errors go straight to dead. Retryable errors follow the backoff.
```

### EMAIL RULES

```text
25. Sending must be safe to run twice. Follow SKILLS: send-email-safely exactly.
26. The job id is the provider idempotency key.
27. MAIL_TRANSPORT defaults to fake. The real transport is used only in step 8, and only
    when the owner says so. Never from a test or a loop.
```

### TESTING

```text
28. Every requirement in PRD section 7 gets a test that can fail.
29. Race and crash tests use real processes (two workers, kill -9), not mocks.
30. Record each break-it test result as pasted output.
```

### GIT

```text
31. Commit only work whose test you ran and passed. Unverified work stays uncommitted and
    is named in the report with the reason.
32. One step per commit. Message format: "S3: single worker claim and fake send".
33. Never commit .env, logs, or screenshots containing real addresses. Never force push.
```

### STEP REPORT (end every step with exactly this)

```text
1. Done
2. Evidence (pasted output or diff)
3. Not verified, and why
4. Deviations from the PRD
5. Questions
6. Safe to commit: yes or no, with the file list
```


---

# Part 3: SKILLS.md

Save as `SKILLS.md`. SQL and code here are patterns to check against your real stack, not drop-in code.

```text
Reusable procedures. Code is TypeScript and SQL shown as PATTERNS. Check each against the
real stack (PRD D1) and the real Postgres version before relying on it. Do not paste blindly.
```

### Skill: claim-job

```text
Use when: the worker needs its next job.
Pattern (one statement; the data-changing parts of a WITH always run). MATERIALIZED stops
the planner folding the inner select into the update, which could weaken the lock. It needs
Postgres 12 or newer. INFERRED from Postgres behaviour; T5 is the proof.
  WITH next AS MATERIALIZED (
    SELECT id FROM jobs
    WHERE status IN ('pending','failed') AND run_at <= now()
    ORDER BY run_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE jobs
    SET status = 'processing', attempts = attempts + 1, locked_by = $1,
        locked_at = now(), started_at = now(), finished_at = NULL
    WHERE id IN (SELECT id FROM next)
    RETURNING *
  ),
  logged AS (
    INSERT INTO job_attempts (job_id, attempt_no, worker_id, started_at)
    SELECT id, attempts, locked_by, now() FROM claimed
  )
  SELECT * FROM claimed;
Done when: T5 passes with two real workers.
```

### Skill: backoff-delay

```text
Use when: a retryable failure needs a next run time. This is the ONLY place delays are made.
  function backoff(attempts: number) {
    const bound = Math.min(CAP, BASE * 2 ** (attempts - 1));
    const delay = bound / 2 + Math.random() * (bound / 2);   // <-- THE JITTER LINE
    return { bound, delay: Math.round(delay) };
  }
Done when: a unit test with BASE=2000 and CAP=300000 shows bounds 2000, 4000, 8000, 16000,
32000 for attempts 1 to 5, every delay sits between half its bound and its bound, and 1000
samples are not all equal.
```

### Skill: fail-or-retry

```text
Use when: the worker catches an error, or the sweep finds a stuck job.
Input: job, error, kind (retryable or permanent).
Steps:
  1. permanent                          -> status dead
  2. retryable and attempts >= max      -> status dead
  3. retryable and attempts < max       -> status failed, run_at = now() + backoff delay
  4. set last_error to a short, address-free message (for example "provider 503")
  5. close the attempt row: finished_at, error, backoff_bound_ms, delay_ms
Guard: worker path uses WHERE status='processing' AND locked_by=me. Sweep path uses
WHERE status='processing' AND locked_at < now() - timeout, inside FOR UPDATE SKIP LOCKED.
Done when: T2 and T3 pass, and a unit test shows a stuck job at max attempts goes dead.
```

### Skill: enqueue-idempotent

```text
Use when: handling POST /api/jobs.
  1. INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *
  2. Row returned          -> respond 202 with the job id.
  3. No row returned       -> SELECT by key.
       same owner and same payload_hash -> respond 200 with that job
       otherwise                        -> respond 409
  4. Do no work. Do not wait. Do not call the mail transport.
Done when: T4 passes, including 20 simultaneous requests.
```

### Skill: sweep-stuck

```text
Use when: running the recovery loop every SWEEP_INTERVAL_MS.
  1. In a transaction select processing jobs with locked_at < now() - STUCK_TIMEOUT_MS,
     FOR UPDATE SKIP LOCKED.
  2. For each, call fail-or-retry with kind retryable and error "stuck: worker lost or slow".
  3. Log one line per recovered job id.
  4. At startup, refuse to run if STUCK_TIMEOUT_MS < 3 * SEND_TIMEOUT_MS.
Done when: T3 passes.
```

### Skill: send-email-safely

```text
Use when: the send_email job runs. Transport call shape:
  send(message, { idempotencyKey: jobId, timeoutMs: SEND_TIMEOUT_MS })
Steps:
  1. Read sent_emails for this job id. State sent -> return success. Send nothing.
  2. INSERT state sending ON CONFLICT DO NOTHING RETURNING job_id.
     A row comes back (it is NEW)   -> continue to step 3.
     Nothing comes back (it existed) -> read its state. See below.
     Existing row in state sending (an earlier try ended with unknown outcome)
                        -> apply UNCERTAIN_SEND_POLICY:
                           resend          -> continue to step 3 (same key, provider dedupes)
                           flag_for_human  -> throw a permanent error "uncertain send"
  3. Call the transport.
  4. Outcome:
     accepted                         -> set state sent, store provider_message_id
     refused with 4xx (incl. 429)     -> DELETE the sending row (we KNOW it was not sent).
                                         429 is retryable. Other 4xx is permanent.
     timeout, network drop, 5xx       -> leave the row as sending (outcome UNKNOWN).
                                         Throw retryable.
Fake transport: records each message by idempotency key. A second call with a key already
recorded returns the first message id and records nothing (this SIMULATES provider dedupe).
FORCE_FAIL=true makes it throw a retryable 503 every time. FAKE_SEND_DELAY_MS sleeps first.
Done when: T6 passes, plus one real send at step 8.
```

### Skill: concurrency-cap

```text
Use when: the worker loop decides whether to claim another job.
  1. Keep a running counter. Add 1 when work starts. Subtract 1 in a finally block.
  2. Claim only while running < WORKER_CONCURRENCY. If no slot is free or no job is ready,
     wait POLL_INTERVAL_MS before looking again.
  3. On every change log: worker=<id> concurrent=<n> max_seen=<m>.
  4. N is per worker process. Two workers can run 2N jobs. Say so in the write-up.
Done when: T1 passes.
```

### Skill: break-it-runner

```text
Use when: recording T1 to T6. Paste output for each. Use test addresses only.
  T1 enqueue 50 at once (fill in PORT and TEST_ADDRESS):
    BODY='{"type":"send_email","payload":{"to":"TEST_ADDRESS","subject":"t","body":"t"},'
    for i in $(seq 1 50); do
      curl -s -X POST http://localhost:PORT/api/jobs -H 'content-type: application/json' \
        -H 'x-user-id: test-user' -d "$BODY\"idempotencyKey\":\"t1-$i\"}" &
    done; wait
  Status counts any time:
    SELECT status, count(*) FROM jobs GROUP BY status ORDER BY status;
  Attempt history for T2:
    SELECT attempt_no, backoff_bound_ms, delay_ms, started_at, finished_at
    FROM job_attempts WHERE job_id = '<id>' ORDER BY attempt_no;
  T3 kill: find the worker with pgrep -f worker, then kill -9 <pid>. Not Ctrl+C. A graceful
    shutdown proves nothing.
  T5 duplicate-claim proof (FORCE_FAIL=false, so no job should ever retry):
    SELECT job_id, count(*) FROM job_attempts GROUP BY job_id HAVING count(*) > 1;
    must return zero rows. The UNIQUE (job_id, attempt_no) constraint backs it up.
    Also count messages per job id in the fake mailbox: each must be 1.
```

### Skill: finish-success

```text
Use when: the work finished and the transport accepted the email (or sent_emails said sent).
  UPDATE jobs
  SET status = 'succeeded', finished_at = now(), locked_by = NULL, locked_at = NULL
  WHERE id = $1 AND status = 'processing' AND locked_by = $2
  RETURNING id;
  Zero rows -> the worker lost the job. Discard, log a warning, touch nothing else.
  One row   -> close the attempt row: finished_at = now(), error = NULL.
Done when: T3 shows the old worker's late result cannot overwrite a recovered job.
```

### Skill: status-snapshot

```text
Use when: you need one screenshot with all five statuses. They will not appear together by
accident. FORCE_FAIL applies to a whole worker, so stage it in phases. INFERRED recipe, not
run. Adjust if the numbers do not line up. Move fast after phase 2.
  1. Worker with FORCE_FAIL=true and MAX_ATTEMPTS=2 (the web app needs the same value, it is
     copied into each job). Enqueue 2 jobs. Wait until both are dead.
  2. Same worker, BACKOFF_BASE_MS=600000 and BACKOFF_CAP_MS larger. Enqueue 1 job. After its
     first try it sits in failed with run_at at least five minutes away.
  3. Stop it. Start a normal worker (FORCE_FAIL=false). Enqueue 3 jobs. Wait for succeeded.
  4. Stop it. Start a worker with FAKE_SEND_DELAY_MS=60000 and WORKER_CONCURRENCY=2. Enqueue
     5 jobs. Two go processing, three stay pending.
  5. Screenshot: SELECT id, status, attempts, run_at FROM jobs ORDER BY created_at;
```

### Skill: manual-retry

```text
Use when: the operator presses retry in the dead letter view (POST only).
  UPDATE jobs
  SET status = 'pending', max_attempts = attempts + $1, run_at = now(),
      locked_by = NULL, locked_at = NULL
  WHERE id = $2 AND status = 'dead'
  RETURNING id;
  $1 is MAX_ATTEMPTS from config. Zero rows returned -> respond 409 (not dead).
  Do NOT reset attempts. Attempt rows are UNIQUE on (job_id, attempt_no) and history stays.
Done when: a retried dead job runs again and its attempt numbers continue from the old ones.
```

### Skill: pre-commit-check

```text
Use when: before every commit.
  git status
  git diff --cached --name-only
  git diff --cached | grep -nEi "(api[_-]?key|secret|token|password|private key)"
  Then confirm by eye: no .env file staged, .gitignore lists .env, README contains no key,
  token or connection string, no screenshot shows a real address.
Matches on NAMES such as ADMIN_TOKEN are expected. Look for VALUES. Limit: grep finds
patterns, not every secret. The eye check is required. Report what you
checked and what you could not check.
```

### Skill: step-report

```text
Use when: finishing any step. Use the exact six-part format in RULES (Done, Evidence, Not
verified, Deviations, Questions, Safe to commit).
```


---

# Part 4: AGENTS.md

Save as `AGENTS.md`. Kept short on purpose so the agent actually follows it. Command and layout lines stay TBD until you answer D1.

### PROJECT

```text
A background job system that sends email off the web request path, retries safely, and
proves what happened to every job. Full detail is in PRD.md.
```

### READ FIRST, IN THIS ORDER

```text
1. RULES.md   2. PRD.md   3. SKILLS.md
```

### NON-NEGOTIABLE

```text
- Never add secrets or secret keys to the README or anywhere in the project that gets sent
  to GitHub or Vercel. Secrets live in environment variables only.
- One step at a time, in PRD section 11 order. Stop after each step and report.
- Show pasted evidence. Label claims CONFIRMED or INFERRED.
- Ask when unclear. Never pick silently.
```

### THE TWO WORDS THAT MATTER

```text
- failed: the last try failed, it WILL be retried, run_at is in the future.
- dead: retries are used up or the error is permanent. A human must act.
```

### COMMANDS (fill in after PRD decision D1. Do not guess them.)

```text
- install:   TBD
- migrate:   TBD
- web app:   TBD
- worker:    TBD
- tests:     TBD
```

### LAYOUT (fill in after step 1)

```text
- TBD
```

### WORKFLOW

```text
1. Read the step in PRD section 11.
2. Do only that step.
3. Run its tests. Paste the output.
4. Run SKILLS: pre-commit-check.
5. End with the six-part STEP REPORT from RULES.
6. Wait for the owner to confirm before the next step.
```

### DO NOT

```text
- Add dependencies, tables or config keys without asking.
- Edit an applied migration.
- Weaken a test to make it pass.
- Log payloads, addresses, tokens or keys.
- Use the real mail transport before step 8.
- Commit anything unverified.
```


---

# Part 5: Step 1 prompt

Give this to the agent once the four files are saved and D1 to D3 are settled. It REPLACES the schema prompt I gave you earlier, which was missing owner_id, payload_hash, the sent_emails table, the backoff columns and the unique attempt numbers.

```text
Read AGENTS.md, RULES.md and PRD.md (sections 5 and 6) before doing anything.

Task: step S1 only. Schema.

Create migrations for the three tables jobs, job_attempts and sent_emails exactly as PRD
section 5 describes, including the status CHECK constraint, the UNIQUE constraints, the
foreign key, and the index on (status, run_at).

Do NOT write the worker, the API, the UI or any config loading in this step.

Run the migration against a LOCAL or dev database only. If you are not sure a database is
local, stop and ask.

Show me: the migration files, the SQL they generate, and the output of listing the tables
and constraints from the database.

End with the six-part STEP REPORT from RULES.md. Label every claim CONFIRMED or INFERRED.

Security rule: never add secrets or secret keys to the README or anywhere in the project
that gets sent to GitHub or Vercel. Use environment variables, and make sure .env is
git-ignored before the first commit.
```

---

# Part 6: Audit

How I checked this pack. Round 1: I built the Word file, read it back out of the .docx with pandoc, and ran mechanical checks (no em or en dashes, your secrets rule present in RULES.md, AGENTS.md and the Step 1 prompt, every config key used, no leftover camelCase column names, status words consistent). Round 2: I re-read the logic as a reviewer, tracing one job through every path (enqueue, claim, success, retryable failure, permanent failure, crash, sweep, manual retry) and asking where each could duplicate an email, lose a job, or fail to produce your evidence. Round 2 also repackaged the pack as Markdown and checked the result. Findings 1 to 12 are round 1. Findings 13 to 22 are round 2. All are fixed unless marked otherwise.

## Findings

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | High | Manual retry that reset attempts to 0 would collide with UNIQUE (job_id, attempt_no) on the next claim, so the retry would error. Found in my own first draft of this pack. | Fixed. Retry now grants a fresh allowance (max_attempts = attempts + MAX_ATTEMPTS) and keeps history. New skill manual-retry and a step 7 test. |
| 2 | High | My earlier email spec (rule 4 of the held prompt) would treat every ordinary retry after a timeout as an uncertain send. That is a flaw in my prior output. | Fixed in send-email-safely. A known refusal deletes the sending row. Only an unknown outcome leaves it and triggers the policy. |
| 3 | Medium | My earlier step 1 schema prompt lacked owner_id, payload_hash, the sent_emails table, the backoff columns and UNIQUE (job_id, attempt_no). | Replaced by the Part 5 prompt. Do not use the old one. |
| 4 | Medium | My earlier advice to use full jitter would make your "delays growing" evidence noisy: a later delay could be shorter than an earlier one. | Changed to equal jitter (half the bound plus a random half). Bound and delay are stored per attempt. |
| 5 | Medium | T3 and T6 pass conditions assumed the resend policy. Under flag_for_human the right result is dead. | Fixed. Both tests now state the expected result for each policy. |
| 6 | Medium | The T5 proof query would flag normal retries as duplicate claims. | Fixed. Run with FORCE_FAIL=false and expect zero rows, plus a per-job count in the fake mailbox. |
| 7 | Medium | The owner check uses an x-user-id header, which anyone can fake. It protects against accidents, not attackers. | Not fixable inside the brief's scope. Stated in PRD risks. Random UUID job ids are the real barrier. |
| 8 | Low | POLL_INTERVAL_MS was defined but no procedure used it. | Fixed in concurrency-cap. |
| 9 | Low | T6 was scheduled after the second worker, though it only needs step 3. Two risky checks were bunched. | Moved to step 3. |
| 10 | Low | Rule 27 said the real mail transport is used in "nothing automatic". Vague. | Reworded: only in step 8, only when the owner says so. |
| 11 | Low | T2 did not say how many rows to expect. | Added: 5 attempts, 4 delays. |
| 12 | Low | The API field name (idempotencyKey) and database column (idempotency_key) differ. | Stated in FR1 so the agent does not rename one to match the other. |
| 13 | High | A manual retry days later can outlive the provider's idempotency key. If sent_emails says "sending", the retry may send a second copy. | Fixed. FR10: the dead letter view shows the sent_emails state and the retry button warns "check the provider first". Added to risks. |
| 14 | Medium | D4 said use resend if the provider supports idempotency keys. That is not enough: the key must also outlive the retry window. | Fixed. D4 now requires D3(a) and D3(b). |
| 15 | Medium | FAKE_SEND_DELAY_MS at or above SEND_TIMEOUT_MS makes the send time out instead of hang, so T3 would test the wrong thing. | Fixed. Startup check added to FR14 and noted in config. |
| 16 | Medium | "Jobs table showing every status" had no way to happen: FORCE_FAIL is global to a worker, so failed, dead, succeeded, processing and pending never coexist naturally. | Added skill status-snapshot, a five-phase staging recipe. INFERRED, not run. |
| 17 | Medium | The claim query's inner select could be folded into the UPDATE by the planner (Postgres 12 and newer), which may weaken the row lock. | Fixed. WITH next AS MATERIALIZED. INFERRED from Postgres behaviour. T5 is the proof. |
| 18 | Low | No procedure said how to finish a successful job or close its attempt row. Only failure was covered. | Added skill finish-success with the same guard. |
| 19 | Low | send-email-safely did not say how to tell a new sending row from an existing one. | Fixed. INSERT ... RETURNING job_id: a row back means new. |
| 20 | Low | The flag_for_human risk mentioned timeouts only. 5xx errors behave the same way. | Fixed. |
| 21 | Low | As plain text, the files would collapse into one paragraph in a Markdown viewer and the aligned tables would break. | Fixed in the Markdown files. Headings added, and each section sits in a fenced block so layout survives. |
| 22 | Low | FR1 repeated the idempotencyKey versus idempotency_key note ambiguously, so an agent might rename one. | Reworded: keep both names as they are. |

## Block on

- Settle D1 (stack and ORM), D2 (where the worker runs), D3 (mail provider) and D4 (uncertain-send policy) before the agent starts step 1. For D3, read the provider's docs for idempotency key support AND how long the key is remembered. I have not verified any provider.
- Fill in the COMMANDS and LAYOUT lines of AGENTS.md after D1. They are TBD on purpose so the agent does not guess.
- Confirm your Postgres version is 12 or newer (the MATERIALIZED keyword). On an older version, tell the agent and it must ask before changing the claim query.
- Treat the SQL in SKILLS.md as patterns. Test T5 with two real workers is the gate for the claim query. The guarded finish needs its own test (finish-success skill).

## Nice to have

- Stop claiming new jobs when the worker receives a shutdown signal (graceful shutdown).
- A heartbeat that refreshes locked_at for long jobs. Not needed for email, which finishes in seconds.
- Scope idempotency keys per owner so a key's existence never leaks across users.
- A reveal button for the masked recipient in the dead letter view.
- A database CHECK that locked_by is set whenever status is processing.

## Not verified

- No SQL or code in this pack has been run. There is no Postgres in my environment. The claim, sweep, finish and retry SQL, and the MATERIALIZED behaviour, are INFERRED from my knowledge of Postgres until the step 3, 5 and 6 tests pass.
- The status-snapshot recipe is INFERRED. I have not run it.
- Nothing about your mail provider is confirmed.
- The Word file was rendered in LibreOffice, not Word. The Markdown was checked as text and by parsing it, not in your editor.
