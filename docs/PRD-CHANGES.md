# PRD changes

Where this goes: `PRD.md` does not exist as a separate file in this project. The PRD is Part 1 of
`Background_Jobs_Project_Pack.md`, so these changes are kept here, in `docs/PRD-CHANGES.md`, and are
meant to be read together with that Part 1. Where a change replaces PRD text, the PRD item is named.

This file holds no secrets, no addresses and no job payloads.

## 1. Meaning of "succeeded"

**Succeeded means the mail server accepted the message. It does not confirm delivery.** Bounces that
arrive later (a mailbox that does not exist, a full mailbox, a spam rejection) are invisible to this
system. See limit G20 in section 15. The home page says the same in one line.

## 2. FR6: how SMTP errors are sorted (replaces the FR6 wording for the real transport)

SMTP is not HTTP. The fake transport and the tests keep the numbers the PRD used, but the real
transport follows these rules:

| What happened | Kind | Notes |
|---|---|---|
| The server replied 4xx (421, 450, 451, 452, 454 and so on) | retryable | A 4xx is a temporary refusal. A temporary login refusal (454) is included. |
| The server replied 5xx | permanent | Goes straight to dead. |
| Login failure: reply 530, 534 or 535, or a reply to an AUTH command | permanent | Fix the mail account setting first, then use manual retry. Stored as `mail account login failed`. |
| The mail library rejects before anything is sent: `EAUTH`, `EENVELOPE`, `EMESSAGE` | permanent | Stored as `mail account login failed`, `recipient address rejected`, `message rejected before sending`. Trying again cannot change these. |
| A timeout or dropped connection, and no part of the message was ever handed to the connection | retryable | Nothing can have been delivered. |
| A timeout or dropped connection AFTER the message body was handed over | **outcome unknown** | Stored as `provider outcome unknown: smtp <code>`. The `sent_emails` row stays `sending`. See section 8. |

**Synthetic status labels.** When the library gives no reply, the transport still has to hand the
worker a number. Those numbers are labels, not something a server said: 421 (nothing was sent, try
later), 535 (login failed), 550 (recipient rejected), 552 (message rejected). Nobody should read them
as real server replies.

How "known not sent" is decided: by whether the body stream was pulled, never by nodemailer's
`error.command`. nodemailer reports the command `CONN` even after the whole message was sent, so
`error.command` cannot be trusted for this.

## 3. FR1: enqueue and the demo-level caller

- A missing `x-user-id` header gives **401** `{"error":"x-user-id header required"}`, on both
  `POST /api/jobs` and `GET /api/jobs/:id`.
- A malformed recipient gives **400** `{"error":"invalid recipient: payload.to <reason>"}` before any row
  is written. The reason is a fixed phrase and never repeats the address.
- The recipient check is **ASCII-only and checks shape only**: exactly one `@`, a plain local part, a
  domain that looks like `name.tld`, length limits, no spaces, commas, semicolons, quotes or angle
  brackets. An address in good shape whose mailbox does not exist still passes, because nothing can
  prove a mailbox exists before sending. Internationalised addresses are refused.

## 4. FR10 and the dead letter page: three operator actions

All three need the admin token in the `x-admin-token` header (never in a URL, cookie or storage) and act
only while the job is **dead**. Otherwise the server answers 409 and changes nothing. An unknown or
malformed id answers 404. The page shows the buttons only for dead rows.

| Action | Route | What it does |
|---|---|---|
| Retry | `POST /api/admin/dead-jobs/:id/retry` | dead -> pending, `max_attempts = attempts + MAX_ATTEMPTS`. Attempts are not reset. Can send a duplicate if the last try's outcome is unknown. |
| Mark as not sent | `POST /api/admin/dead-jobs/:id/mark-not-sent` | For a dead job whose email state is `sending`, after the operator checked the Sent folder and found nothing: deletes the `sending` row so a retry can send again. Can send a duplicate if the email was in fact delivered. Logs the job id only. |
| Mark as sent | `POST /api/admin/dead-jobs/:id/mark-sent` | For a dead job whose email state is `sending`, after the operator found the email: in ONE transaction the job goes **dead -> succeeded** (guarded by `status = 'dead'`, sets `finished_at`, `last_error = 'marked sent by operator'`) and `sent_emails` goes `sending -> sent`. If either update changes zero rows the transaction is rolled back and the answer is 409 (a dead job with no `sending` row answers 409 `no unknown-outcome send to mark as sent`). Logs the job id only. On the page this is an inline form: the operator types the job's 20-character reference and the "Confirm mark as sent" button stays disabled until the text matches exactly. This guards against a mis-click only. The server does not see the typed text. |

New allowed transition (added to PRD section 6): **dead -> succeeded**, only through mark-sent.

For a `sending` row the page shows the job's reference (section 11) with the text "Search the Sent folder
of the sending account for this reference", and warns that retry and mark-as-not-sent can each send a
duplicate. The attempt history shows each attempt's worker id, start time, finish time and error.

No stored audit record is kept of mark-not-sent or mark-sent. Only a log line with the job id is written.
An audit table would need a schema change.

## 5. Heartbeat, its setting, and the startup checks

- While a worker runs a job it repeats one statement every `HEARTBEAT_INTERVAL_MS`:
  `UPDATE jobs SET locked_at = now() WHERE id = $1 AND locked_by = $2 AND status = 'processing' RETURNING id`.
  The sweep therefore sees a live lock on a slow but healthy job.
- A beat that changes zero rows means the job was lost (section 9).
- A beat that THROWS (a database hiccup) proves nothing: it is not a loss. The worker logs one line per
  job, `WARN worker=<w> job=<id> heartbeat failed: <code or name>; will keep trying` (never the error
  message), and goes on beating. When beating resumes, or the job ends while beats were failing, it logs
  one line: `worker=<w> job=<id> heartbeat recovered after <n> failed beats`.
- `HEARTBEAT_INTERVAL_MS` is a new required setting (integer, at least 1; the project's value is set in the
  environment). The worker refuses to start if it is missing or not a whole number.
- Startup checks (FR14), in this order, with these exact texts:
  1. `STUCK_TIMEOUT_MS must be at least 3 * SEND_TIMEOUT_MS`
  2. `STUCK_TIMEOUT_MS must be at least 3 * HEARTBEAT_INTERVAL_MS`

  When both are broken, the first is reported.

## 6. Worker pool sizing

The worker's database pool has `max = max(10, 2 * WORKER_CONCURRENCY + 4)`: two connections per running
job (its statements and its heartbeat), the claim loop, the sweep, and some headroom. Its
`connectionTimeoutMillis` is `2 * SEND_TIMEOUT_MS`, so running out of connections is an error and not an
endless wait. That value is above `SEND_TIMEOUT_MS` and always below `STUCK_TIMEOUT_MS`, because the
startup check forces `STUCK_TIMEOUT_MS >= 3 * SEND_TIMEOUT_MS`. At the default concurrency of 5, max is 14.

## 7. Attempts, the sweep, and finishing

- **Attempts are counted at claim** (already a deviation in PRD section 6, kept). A crash therefore counts
  as an attempt without the sweep having to remember.
- **The sweep may take over a job in `processing` with a stale `locked_at` only through `failOrRetry`.**
  There is no second code path. The stale-lock condition is part of the takeover statement itself, so a
  heartbeat that refreshed the lock a moment earlier wins.
- **Finishing is one transaction.** The job update and the attempt row update commit together or not at
  all. A zero-row guard (the worker no longer owns the job) rolls the transaction back. A crash between
  the two updates leaves both unchanged.

## 8. Sending safely: the ownership re-check and the "sending" row

- **Ownership re-check.** Right before anything is sent, the worker runs the same ownership statement as
  the heartbeat. Zero rows: it sends nothing, creates no `sending` row, logs the lost-job warning once,
  drops the job and carries on.
- **`sent_emails` is a fact about the email, not about the job.** When the mail server accepts a message,
  `sending -> sent` is recorded even if the worker has lost the job meanwhile. The update only moves
  `sending` to `sent`, so nothing can turn `sent` back into `sending`.
- Under `UNCERTAIN_SEND_POLICY=flag_for_human`, a retry that finds a `sending` row dies as `uncertain send`
  and goes to dead for a human. With `resend` it sends again. This system runs with `flag_for_human`
  because SMTP gives no way to ask whether a message went out.

## 9. The lost-job warning

A worker that learns it lost a job writes one line, whichever path noticed first (the re-check, a
heartbeat, or a guarded update):

```
WARN worker=<worker id> job=<job uuid> lost the job: owner=<current owner | none | unknown> status=<current status | unknown>; its result was discarded
```

The format is pinned by a test, because the real-mail tests read the logs. The loser then writes nothing
for that job: no job update, no attempt update, no failure record.

## 10. What happens once SMTP already has the message, and the loss race

A heartbeat cannot recall a message that SMTP has accepted.

- **Loss found before the SMTP call.** The send is refused by a wrapper, the `sending` row is deleted,
  and the mail server is never called.
- **Loss found during the send.** One lost-job warning is logged at once. The SMTP call completes. The
  `sent_emails` row is set to `sent` with the provider message id. The loser does NOT write the job row or
  the attempt row. A late finish from the loser changes zero rows.
- **The race.** The sweep (or a retry) can hand the job to a new owner while the loser's SMTP call is still
  in flight. If the new owner reaches the `sending` row before the loser records `sent`, then under
  `flag_for_human` the new owner finds `sending`, concludes the outcome is unknown, and the job ends **dead
  as `uncertain send` although the mail did go out**. The job is not retried, so no duplicate is sent.
- **How mark-sent resolves it.** The operator searches the Sent folder for the job's reference, finds the
  email, and types the reference into the **Mark as sent** form and confirms. The job becomes succeeded and the email row becomes `sent`.

This race is narrow (the heartbeat keeps the lock fresh, and the sweep needs a lock older than
`STUCK_TIMEOUT_MS`), but it is not zero. It was reasoned about and tested in pieces. It has not been
reproduced end to end with a real mail server.

## 11. Traceability: X-Job-Ref and the Message-ID

- No header of any email carries the raw job id.
- **`X-Job-Ref`** = the first 20 hex characters of the SHA-256 of the job id. It is one-way: nobody can get
  the job id back from it, but anyone can compute it from a known id.
- **`Message-ID`** = `<ref@sender-domain>`, where `ref` is the same value and the domain comes from the
  configured sender address. The worker reads that setting; the web process never does. The worker
  refuses to start if the sender has no dotted domain.
- The dead letter page shows only the reference. The operator searches the Sent folder for it.
- **Earlier emails carry the old format.** Emails sent before this change have a Message-ID of the form
  `<job id>@bgjobs.invalid` (real sends) or a bare job id (fake transport). They are not rewritten, and
  the page's reference does not find them.

## 12. Migration order

Apply `migrations/001_create_jobs_tables.sql`, then `migrations/002_job_attempts_worker_id_not_null.sql`.
There is no migration runner. Migration 001 has its own `BEGIN` and `COMMIT`, so 001 and 002 do **not**
roll back together as one unit: if 002 fails, 001 stays applied. Migration 002 makes
`job_attempts.worker_id` NOT NULL.

## 13. The home page

- The **To** field starts **empty** and stays required. There is no default address.
- The page says: "Succeeded means the mail server accepted the message. It does not confirm delivery."

## 14. Tests that guard the database

DB tests refuse to connect to any database not named `jobs_test` (`test/guard.setup.ts`). Run them with a
process-only `DATABASE_URL` pointing at it.

## 15. Known limits

- **G20: bounces are invisible.** The system learns only what the SMTP server says at send time. A
  message accepted and later bounced still shows as succeeded.
- **G22: SMTP cannot give exactly once.** SMTP has no idempotency key. When the outcome of a send is
  unknown, the system can only choose between a possible duplicate (`resend`) and a possible missed email
  needing a human (`flag_for_human`). It uses `flag_for_human`. The idempotency of sending rests on the
  `sent_emails` record, which cannot see a message that was accepted but never recorded.
- **G24: the admin token has no attempt limit.** Audit finding only. No change was made.
- The dead letter page has not been checked in a browser.

## 16. Graceful shutdown

On a stop signal the worker:

1. Stops claiming new jobs (a claim already in progress may still hand it one last job, which is then
   waited for).
2. Logs `worker=<id> stopping, waiting for <N> jobs` and waits up to `SEND_TIMEOUT_MS` for running jobs
   to finish. Counted from the signal.
3. Stops the sweep timer, and every heartbeat timer, and exits with code 0.
4. If jobs are still running when the wait ends, logs
   `worker=<id> gave up waiting after <ms> ms, leaving <n> jobs for the sweep`, stops their heartbeats and
   exits **without** marking them finished. Their locks stop being refreshed, so the sweep recovers them
   after `STUCK_TIMEOUT_MS`, the same way as after a hard kill. If the mail server had already accepted a
   message, it is still recorded in `sent_emails` only if the process lived to record it. Under
   `flag_for_human` a lost record shows as `uncertain send` and needs a human (section 10).
5. A **second** signal exits at once with code 1.

Signals the worker listens for: `SIGINT`, `SIGTERM`, `SIGBREAK`, `SIGHUP`.

**On Windows.** Node documents: Ctrl+C in a console delivers `SIGINT`; Ctrl+Break delivers `SIGBREAK`; closing
the console window delivers `SIGHUP`, and Windows ends the process unconditionally about 10 seconds
later, so a shutdown that needs the full `SEND_TIMEOUT_MS` may be cut short there; `SIGTERM` is never
delivered by Windows itself. On this machine (Node 24, Windows 11) `process.kill(pid, "SIGINT")` and
`process.kill(pid, "SIGTERM")` ended a child with a handler installed WITHOUT running the handler, and
`process.kill(pid, "SIGBREAK")` and `"SIGHUP"` did nothing. So `Stop-Process`, `taskkill /F`,
`process.kill` and a service manager's stop are all hard kills here. The only graceful stop is Ctrl+C (or
Ctrl+Break) typed in the worker's own console. A hard kill is what the sweep exists for.

## 17. The dead letter page: what it shows (brief Step 7)

The page lists dead jobs, newest death first, **at most 100**. The list answer also carries the **total**
number of dead jobs, and the page header says "Showing K of N dead jobs". With no dead jobs it says
"No dead jobs."

Each job shows:

- the job id and type;
- the created time and the time it **died**, both in UTC and labelled "UTC" (for example
  `2026-10-05 00:31:12 UTC`);
- `attempts n of max`;
- the last error (a short fixed phrase, never an address);
- the email state (none, `sending` or `sent`) and the job reference (section 11), with the "outcome
  unknown" warnings for a `sending` row (section 4);
- the payload as plain text: the masked recipient, the subject, and the **first 200 characters of the body**
  (a missing field shows "(none)", a cut body says so);
- the full attempt history: worker, start, finish, error, and the backoff bound and delay.

The page also says "Recipient hidden for privacy." and explains each button in plain text:

- **Retry:** Puts the job back in the queue with a fresh allowance of attempts.
- **Mark not sent:** Use only if you checked that the email was NOT sent. Retrying can send a duplicate.
- **Mark as sent:** Use only if you checked the Sent folder and the email WAS sent. Type the reference to
  confirm.

Messages: "Wrong or missing admin token." for a 401, "Could not reach the server." when the network fails,
"Could not load (<status>)." for other failures. None repeats the token.

**Payload privacy decision.** The server, not the page, shapes the payload. It keeps only `to` (masked),
`subject` and the first 200 characters of `body`, and drops every other field, so the rest of a long body
and any extra field never leave the server. Before this change the whole payload, including the full body,
reached the browser. The owner may later hide the body too.

**Retry deviates from the brief's wording.** The brief says a button retries a dead job. Here retry does not
reset `attempts`: it sets `max_attempts = attempts + MAX_ATTEMPTS`, which gives a fresh allowance. The
reason is that `job_attempts` is unique on `(job_id, attempt_no)` and the history must be kept, so attempt
numbers continue (4, 5, 6 after 3 attempts) and the history is never overwritten.

**Refresh rule.** The page has **no automatic refresh**. It reloads the list only when the operator presses
Load and after retry, mark-not-sent or mark-as-sent. A small **Refresh** button, shown with the list, an empty list and a wrong-token message, does the same as Load: it re-fetches the list once when pressed and nothing more. A reload keeps text typed into the mark-as-sent box.
If an automatic refresh is ever added it must run no faster than every 5 seconds and must skip a refresh
while a text box has focus, while a confirm dialog is open, and while a request is in flight.

The admin token stays in a request header only: never in a URL, cookie, local storage, the page or its
script. The page keeps its strict content-security policy and inserts server text with `textContent` only.
