-- S1: schema for the background job system (PRD section 5).
-- Requires Postgres 13 or newer for gen_random_uuid() without an extension.

BEGIN;

CREATE TABLE jobs (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    type            text        NOT NULL,
    owner_id        text        NOT NULL,
    payload         jsonb       NOT NULL,
    payload_hash    text        NOT NULL,
    status          text        NOT NULL DEFAULT 'pending',
    attempts        integer     NOT NULL DEFAULT 0,
    max_attempts    integer     NOT NULL,
    last_error      text,
    run_at          timestamptz NOT NULL DEFAULT now(),
    locked_by       text,
    locked_at       timestamptz,
    started_at      timestamptz,
    finished_at     timestamptz,
    idempotency_key text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT jobs_status_check
        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
    CONSTRAINT jobs_idempotency_key_key UNIQUE (idempotency_key)
);

CREATE INDEX jobs_status_run_at_idx ON jobs (status, run_at);

CREATE TABLE job_attempts (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           uuid        NOT NULL REFERENCES jobs (id),
    attempt_no       integer     NOT NULL,
    worker_id        text,
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz,
    error            text,
    backoff_bound_ms integer,
    delay_ms         integer,
    CONSTRAINT job_attempts_job_id_attempt_no_key UNIQUE (job_id, attempt_no)
);

CREATE TABLE sent_emails (
    job_id              uuid        PRIMARY KEY REFERENCES jobs (id),
    state               text        NOT NULL,
    provider_message_id text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sent_emails_state_check CHECK (state IN ('sending', 'sent'))
);

COMMIT;
