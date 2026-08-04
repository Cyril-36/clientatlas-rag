/**
 * Storage layout shared by the application and the worker.
 *
 * The bucket name lives here rather than in either one because both reach the
 * same objects for different reasons — the application signs URLs for users,
 * the worker downloads bytes for a job — and two copies of a bucket name is a
 * rename away from a very confusing bug.
 */
export const DOCUMENTS_BUCKET = "documents";
