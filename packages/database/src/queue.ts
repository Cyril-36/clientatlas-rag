import type postgres from "postgres";

/**
 * The ingestion work queue.
 *
 * Runs as `clientatlas_worker`, which has policies covering exactly
 * `ingestion_jobs` and `document_chunks` and nothing else. There is no
 * BYPASSRLS credential here — a background process needs breadth across
 * tenants, but only within the two tables ingestion actually touches.
 */

export interface ClaimedJob {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  /** Including the attempt just claimed, so the first run reports 1. */
  readonly attempts: number;
  readonly maxAttempts: number;
}

export const DEFAULT_BASE_BACKOFF_SECONDS = 30;
export const DEFAULT_MAX_BACKOFF_SECONDS = 15 * 60;
/** A running job untouched for this long is assumed abandoned. */
export const DEFAULT_STALE_AFTER_SECONDS = 120;

/**
 * Exponential backoff, capped.
 *
 * Pure and exported so the schedule is testable without a database — the
 * failure path is the one least likely to be exercised by hand, and a wrong
 * backoff either hammers a failing dependency or delays a retry by hours.
 */
export function backoffSeconds(
  attempts: number,
  baseSeconds = DEFAULT_BASE_BACKOFF_SECONDS,
  maxSeconds = DEFAULT_MAX_BACKOFF_SECONDS,
): number {
  if (attempts <= 0) {
    return baseSeconds;
  }

  const exponential = baseSeconds * 2 ** (attempts - 1);
  return Math.min(exponential, maxSeconds);
}

interface JobRow {
  id: string;
  organization_id: string;
  document_id: string;
  document_version_id: string;
  attempts: number;
  max_attempts: number;
}

function toClaimedJob(row: JobRow): ClaimedJob {
  return {
    id: row.id,
    organizationId: row.organization_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

/**
 * Takes the next eligible job, or returns null.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe to run from several workers
 * at once: a row already locked by another claimer is stepped over rather than
 * waited on, so two workers never receive the same job and neither blocks.
 * Without SKIP LOCKED this degenerates into workers queuing behind each other
 * on the same row, which looks like a slow queue rather than a bug.
 *
 * The CTE selects before updating so the lock is taken on exactly one row.
 */
export async function claimNextJob(db: postgres.Sql, workerId: string): Promise<ClaimedJob | null> {
  const rows = await db<JobRow[]>`
    with claimed as (
      select id
      from ingestion_jobs
      where status = 'queued'
        and run_after <= now()
      order by run_after
      for update skip locked
      limit 1
    )
    update ingestion_jobs j
    set status       = 'running',
        attempts     = j.attempts + 1,
        claimed_by   = ${workerId},
        claimed_at   = now(),
        heartbeat_at = now(),
        updated_at   = now()
    from claimed
    where j.id = claimed.id
    returning j.id, j.organization_id, j.document_id, j.document_version_id,
              j.attempts, j.max_attempts
  `;

  const row = rows[0];
  return row ? toClaimedJob(row) : null;
}

/**
 * Signals that a claim is still alive.
 *
 * Scoped by `claimed_by` so a worker cannot refresh a job that has already been
 * reclaimed and handed to someone else — otherwise a slow worker that was
 * presumed dead could resurrect its claim while a second worker is midway
 * through the same document.
 */
export async function heartbeat(
  db: postgres.Sql,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    update ingestion_jobs
    set heartbeat_at = now(), updated_at = now()
    where id = ${jobId} and claimed_by = ${workerId} and status = 'running'
    returning id
  `;

  return rows.length > 0;
}

export async function completeJob(db: postgres.Sql, jobId: string): Promise<void> {
  await db`
    update ingestion_jobs
    set status = 'succeeded', failure_code = null, heartbeat_at = null, updated_at = now()
    where id = ${jobId}
  `;
}

export type JobFailureOutcome = "retry_scheduled" | "gave_up";

/**
 * Records a failure, and decides whether it is worth trying again.
 *
 * `failureCode` must be a stable identifier, never a parser message: those can
 * contain fragments of the document, and this column is read back into the UI.
 */
export async function failJob(
  db: postgres.Sql,
  jobId: string,
  failureCode: string,
  baseSeconds = DEFAULT_BASE_BACKOFF_SECONDS,
): Promise<JobFailureOutcome> {
  const [job] = await db<{ attempts: number; max_attempts: number }[]>`
    select attempts, max_attempts from ingestion_jobs where id = ${jobId}
  `;

  if (!job) {
    return "gave_up";
  }

  if (job.attempts >= job.max_attempts) {
    await db`
      update ingestion_jobs
      set status = 'failed', failure_code = ${failureCode},
          claimed_by = null, heartbeat_at = null, updated_at = now()
      where id = ${jobId}
    `;
    return "gave_up";
  }

  const delay = backoffSeconds(job.attempts, baseSeconds);

  await db`
    update ingestion_jobs
    set status = 'queued', failure_code = ${failureCode},
        run_after = now() + make_interval(secs => ${delay}),
        claimed_by = null, claimed_at = null, heartbeat_at = null, updated_at = now()
    where id = ${jobId}
  `;

  return "retry_scheduled";
}

/**
 * Returns abandoned jobs to the queue.
 *
 * A worker killed mid-parse cannot release its own claim, so without this the
 * job stays `running` for ever and the document never becomes ready — the
 * failure mode is silence, which is the worst kind.
 *
 * Jobs that have already used their attempts are marked failed instead of being
 * re-queued, so a job that reliably kills its worker cannot loop indefinitely.
 */
export async function reclaimAbandonedJobs(
  db: postgres.Sql,
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
): Promise<number> {
  const rows = await db<{ id: string }[]>`
    update ingestion_jobs
    set status = case when attempts >= max_attempts then 'failed'::ingestion_job_status
                      else 'queued'::ingestion_job_status end,
        failure_code = case when attempts >= max_attempts then 'WORKER_ABANDONED'
                           else failure_code end,
        claimed_by = null,
        claimed_at = null,
        heartbeat_at = null,
        run_after = now(),
        updated_at = now()
    where status = 'running'
      and heartbeat_at < now() - make_interval(secs => ${staleAfterSeconds})
    returning id
  `;

  return rows.length;
}
