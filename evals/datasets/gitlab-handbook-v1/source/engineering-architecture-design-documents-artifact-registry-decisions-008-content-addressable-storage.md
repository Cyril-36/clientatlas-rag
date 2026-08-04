---
slug: engineering-architecture-design-documents-artifact-registry-decisions-008-content-addressable-storage
title: "Artifact Registry ADR 008: Content-Addressable Storage"
source_url: "https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/artifact_registry/decisions/008_content_addressable_storage/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: "Artifact Registry ADR 008: Content-Addressable Storage"
owning-stage: "~devops::package"
description: "Decision to use content-addressable storage"
toc_hide: true
---

<!-- Design Documents often contain forward-looking statements -->
<!-- vale gitlab.FutureTense = NO -->

## Context

The Artifact Registry must balance:

- **Deduplication efficiency**: Reducing redundant storage of identical content
- **Operational complexity**: Managing deduplication across different scopes
- **Cost attribution**: Clear tracking of storage costs per namespace
- **Performance**: Fast artifact uploads and downloads
- **Integrity**: Verification that artifacts haven't been corrupted or tampered with

Artifact storage typically involves storing the same content multiple times:

- Multiple versions of packages with identical dependencies
- Base container layers shared across many images
- Binary files that haven't changed between versions

Storage in the Artifact Registry is organized around **namespaces**. A namespace is an internal entity with an immutable, customer-chosen slug and an internal UUIDv7 ID. It is the isolation and deduplication boundary. Each namespace maps 1:1 to an organization for the foreseeable future. The slug appears in all URLs. A hash of the internal ID is used for storage path isolation. See [ADR-022](022_namespace_decoupling.md) for details.

## Decision

**We use content-addressable storage with SHA256-based identification and namespace-scoped deduplication.**

We identify all artifacts by their SHA256 content hash, enabling:

- Automatic deduplication within namespaces (one copy per unique blob) - see [ADR-002](002_storage_deduplication_scope.md), [ADR-022](022_namespace_decoupling.md)
- Immutable content paths (integrity verification through content hash)
- Efficient storage utilization within namespace boundaries
- Clear integrity verification through hash comparison

**Deduplication scope is limited to within individual namespaces**, not instance-wide (see [ADR-022](022_namespace_decoupling.md)). Namespaces map 1:1 to organizations for the initial release, providing storage efficiency within each namespace while maintaining clear boundaries for security, predictable performance, and cost attribution.

Content hashes use the `algorithm:hex` format (for example, `sha256:a3b5c7d9...`), following the [OCI Content Descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md) convention. SHA256 is the only supported algorithm at launch. Algorithm migration (for example, SHA256 to SHA-3) is non-trivial. It would involve rehashing existing content, supporting dual hash lookups during transition, and resolving deduplication across algorithms. This is out of scope for this ADR.

We treat SHA256 as collision-free and perform no secondary content comparison (for example, size or byte comparison) during deduplication. At 1,000 unique blob uploads per second sustained, well above [ADR-003](003_system_requirements.md)'s scale targets, reaching one trillion stored objects takes approximately three decades, at which point the probability of a single collision is approximately 10^-53. The birthday bound for 50% collision probability requires approximately 2^128 (~3.4 × 10^38) objects, which is not reachable at any plausible operational scale.

### Storage Path Strategy

Object storage providers partition data across shards based on key prefixes. When many objects share a common prefix, writes concentrate on a small number of shards, creating hot partitions. GCS [recommends hashing](https://cloud.google.com/storage/docs/request-rate) for high-write sequential workloads to distribute load evenly. S3 has [improved its auto-partitioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html) since 2018, but the per-prefix rate limit remains at 3,500 writes/sec and 5,500 reads/sec. Using a flat identifier as the top-level prefix would concentrate all of a namespace's operations under a single prefix, which could become a bottleneck for active namespaces.

Both [GCS](https://cloud.google.com/storage/docs/objects) and [S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html) impose a maximum object key length of 1,024 bytes (UTF-8 encoded). The sharding overhead (extra `/` separators and repeated prefix characters) is well within this bound.

The storage path strategy is informed by production metrics from the GitLab.com container registry. Current operation rates are within GCS per-prefix limits, but the Artifact Registry should be designed for 10x growth to account for additional artifact formats (Maven, npm) that generate higher operation counts per byte, skewed traffic distribution across namespaces, and growing customer adoption.

The storage hierarchy uses multi-level sharding to ensure efficient access patterns and namespace isolation. The top-level `artifact_registry/` prefix is configurable via the `root_directory` storage configuration field (default: `"artifact_registry"`), supporting shared-bucket deployments with path prefixes per [ADR-006](006_technology_stack.md):

```plaintext
{root_directory}/
├── {namespace_hash[0..1]}/
│   └── {namespace_hash[2..3]}/
│       └── {namespace_hash}/
│           ├── objects/
│           │   └── {content_hash[0..1]}/
│           │       └── {content_hash[2..3]}/
│           │           └── {content_hash}
│           └── uploads/
│               └── {upload_id}/
```

Where:

- `namespace_hash`: SHA256 hash of the Namespace's internal UUIDv7 ID ([ADR-022](022_namespace_decoupling.md)) for top-level storage isolation (see [Top-Level Storage Identity](#top-level-storage-identity) below). The first two levels (2 hex characters each, 65,536 prefix buckets) distribute writes across storage partitions. The third level uses the full hash for namespace isolation.
- `content_hash`: SHA256 hash of the blob content, used directly as the storage key. Same sharding pattern: two distribution levels followed by the full hash.
- `upload_id`: UUID for temporary upload sessions

Both `objects/` and `uploads/` live under the same namespace partition. This means the move from `uploads/{upload_id}` to `objects/{content_hash}` is always intra-partition, with no cross-partition data movement during the upload flow.

Storage paths are reversibly parseable: given an object key, the namespace hash and content hash can be extracted by parsing the path components without a database lookup. A storage walk can identify which namespace owns each blob and what its content hash should be, enabling comparison against database records.

**Example paths** (where `73475cb...` is `SHA256(namespace_id)` and `a3ed95c...` is `SHA256(blob content)`):

```plaintext
# Stored object
artifact_registry/73/47/73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049/objects/a3/ed/a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4

# In-progress upload
artifact_registry/73/47/73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049/uploads/550e8400-e29b-41d4-a716-446655440000
```

#### Upload Path Structure

Upload paths are flat under the namespace partition (no sharding on `upload_id`), unlike `objects/` which uses multi-level sharding. This is acceptable because:

- **No enumeration needed**: Upload sessions are tracked in the database, so discovering uploads never requires listing the `uploads/` prefix in object storage. Sharding benefits listing performance, which we avoid entirely.
- **Object storage handles flat key spaces**: S3 and GCS distribute keys by hash internally. A flat `uploads/` prefix with thousands of concurrent UUIDs does not create a hot partition.
- **Short-lived objects**: Upload paths are temporary: they exist only for the duration of the upload session (minutes to hours), not permanently like `objects/`.

**Alternatives considered:**

- **Sharded uploads** (for example, `uploads/{id[0..1]}/{id[2..3]}/{id[4..-1]}`): Would improve listing performance, but listing is unnecessary with database tracking. Adds path complexity for no operational benefit.
- **Global uploads outside namespace partition**: Would require cross-partition moves on completion, adding latency and failure modes. Rejected because intra-partition moves are simpler and faster.

The top-level storage path uses a SHA256 hash of the namespace's internal UUIDv7 ID rather than a human-readable identifier such as the namespace slug. Hashed paths are immutable by construction: there is no human-readable value to change, so there is no rename event to propagate. This matches [GitLab's hashed storage standard](https://gitlab.com/groups/gitlab-org/-/work_items/2320), which moved away from human-readable project paths after encountering [Geo sync failures on rename/move operations](https://gitlab.com/gitlab-org/gitlab/-/issues/495147) and performance penalties in distributed systems.

#### Top-Level Storage Identity

**The top-level storage path hashes the Namespace's internal UUIDv7 ID** ([ADR-022](022_namespace_decoupling.md)). Each namespace gets its own top-level storage partition.

This aligns the storage boundary with the deduplication boundary: identical blobs within a namespace are naturally co-located, and cost attribution is a sum of blobs under one hash prefix. Organization merges require no storage movement: each namespace keeps its partition, and the surviving organization simply holds multiple partitions. Namespace IDs are internal and immutable by construction.

For the initial release (one Artifact Registry namespace per organization), this is functionally identical to hashing the organization ID. If an organization has multiple Artifact Registry namespaces in the future, deduplication does not cross namespace boundaries. Identical blobs uploaded to different namespaces within the same org are stored twice. This is an explicit tradeoff acknowledged in [ADR-022](022_namespace_decoupling.md). The [container registry analysis](https://gitlab.com/gitlab-com/content-sites/handbook/-/merge_requests/17524#note_3023542021) shows ~95% of blobs exist in a single top-level namespace, suggesting cross-namespace overlap is low. This figure reflects container image layer-sharing patterns; package registries typically have lower cross-repository dedup because artifacts are usually unique per version, so cross-namespace overlap is expected to be even lower for those formats.

#### Content Hash as Object Key

**We use the SHA256 content hash directly as the object key** (for example, `{hash[0..1]}/{hash[2..3]}/{hash}`). This provides a direct mapping between content identity and storage location. Deduplication is a structural property of the storage layer, not a coordination step. If the destination path already exists, the blob is a duplicate and no new object is written. No database coordination is needed for the deduplication check itself. This also simplifies debugging, since the storage path is derivable from the content hash without a database lookup.

**Alternative considered: random identifier-based paths**. Use a randomly generated UUID as the object key, with the content hash stored in database metadata. This would avoid potential information disclosure (hash enumeration) and provide flexibility for storage reorganization. However, it introduces a required database coordination point for every deduplication check, adds an indirection layer for every read, and changes the concurrent upload and move semantics described in this ADR. The two-phase upload strategy, concurrent upload resolution, and atomic deduplication on move all rely on content-hash-based paths as a structural property. Adopting random identifiers would require redesigning these flows around database-mediated deduplication rather than storage-level convergence, adding complexity without a clear operational benefit for the initial release.

### Two-Phase Upload Strategy

**We use a move-based two-phase upload** (container registry pattern): content is first uploaded to `uploads/{upload_id}`, then moved to `objects/{content_hash}` after hash calculation and deduplication check. This per-blob model applies to all artifact formats. Multi-file package deploys (for example, Maven JAR + POM) are separate upload sessions per file; atomicity across related files within a version is an API-level concern addressed in [ADR-009](009_api_design.md).

The container registry's [blob upload implementation](https://gitlab.com/gitlab-org/container-registry/-/blob/master/registry/storage/blobwriter.go) provides a decade of production-hardened reference for this approach. Lessons from that implementation:

- **Streaming hash computation**: The hash is computed during the write using streaming hash computation, not as a separate pass after upload completes. This avoids re-reading the entire blob from storage, which is critical for multi-GB artifacts.
- **Resumable digest state**: For resumable uploads, the hash state is persisted and restored so that partially uploaded content does not need to be re-hashed from the beginning. The container registry's validation logic handles multiple fallback paths (resumable digest available, algorithm mismatch, full re-hash) that reflect real edge cases encountered in production. The Artifact Registry keeps the streaming hash and resumable state but replaces that full-re-hash fallback with terminate-on-divergence — see [Resumable Uploads and Hash State](#resumable-uploads-and-hash-state) below.
- **Atomic deduplication on move**: The move destination is the content-hash path. If the path already exists, the move is skipped. Deduplication is a structural consequence of content-addressable paths rather than a separate coordination step.
- **Zero-length blob safety invariant**: The SHA256 hash of empty content (`sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) is a known constant. Zero-length writes are only permitted to that specific hash path. Without this invariant, a race between a failed upload (which produces zero bytes) and the move step could silently overwrite existing blob content at an unrelated hash path with an empty object. The system enforces this by checking against the known empty-content hash constant before the move.

**Alternatives considered:**

Two alternative upload patterns were evaluated:

#### Confirm-in-place (CI artifacts pattern)

Content is uploaded with a temporary identifier and confirmed in place using Redis tracking after a deduplication check. This pattern was designed for CI artifacts where deduplication is not a goal: each artifact gets a unique path on upload and stays there. Redis tracking confirms receipt, not content identity. Applying it to a content-addressable system changes the problem because the content hash is not known until the upload completes.

Without speculative uploads (writing directly to the content-hash path before the hash is known), the object must still be moved to its final content-addressed location after hash computation, resulting in the same object storage operations as the move-based approach. The confirm-in-place pattern adds Redis as a hard dependency during uploads without reducing storage operations, and requires Redis-based coordination to handle concurrent uploads of identical content racing to the same hash path, which the move-based staging area solves structurally by isolating each upload by UUID.

#### Direct-to-final-path upload

Upload directly to the content-hash path, skipping the staging area and move operation entirely. For formats where the client supplies the content hash before upload (for example, OCI blob pushes with a `digest` parameter), the server knows the final path at the start of the upload. This eliminates the move operation and its associated cost and failure modes.

This approach does not generalize across all artifact formats. Many package registry formats (Maven, npm, generic) do not supply a content hash before upload, so the server cannot determine the final path until after hash computation completes. For those formats, content must still be written to a temporary location and moved, resulting in the same two-phase flow. Maintaining two upload code paths (direct for hash-known, staged for hash-unknown) adds complexity without eliminating the move-based path.

Direct-to-final-path uploads also change the concurrent upload model. If two clients upload the same content simultaneously, both write to the same destination path. The first to complete succeeds; the second either overwrites (wasting work) or fails with a conflict. The staging area avoids this by isolating each upload by UUID and resolving deduplication at the move step.

If abandoned uploads land directly in the deduplicated object store (`objects/`), distinguishing orphaned partial uploads from valid blobs requires database cross-referencing rather than a simple age-based sweep of the `uploads/` prefix. The staging area provides a structural boundary: anything in `uploads/` older than the session TTL is safe to delete.

#### Why we chose two-phase move

The move-based approach has proven production behavior at container registry scale on GitLab.com with no related incidents. The move overhead is low: on GCS, the atomic [Objects.move](https://cloud.google.com/storage/docs/json_api/v1/objects/move) is metadata-only for same-bucket operations. On S3, `CopyObject` is charged as a PUT ($0.005/1K requests) with free deletes. At container registry production volume, the additional API cost is negligible relative to total storage spend.

The container registry's blob upload implementation is the reference implementation for the Artifact Registry's blob handling. The two-phase upload logic, streaming hash computation, and move semantics are identical between the two systems, with only the storage path structure changing (namespace-based sharding instead of instance-based). Starting from the same approach reduces divergence and provides a clear reference for AI-assisted code generation.

This is not a one-way door. If operational data shows that move costs become a bottleneck at scale, the direct-to-final-path approach provides a clear optimization path for hash-known formats without changing the storage layout.

#### Move Semantics on Object Storage

GCS provides an atomic [Objects.move](https://cloud.google.com/storage/docs/json_api/v1/objects/move) operation, which eliminates the failure modes below for GitLab.com. S3 offers [RenameObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_RenameObject.html) but only on Express One Zone, not standard buckets. For S3 standard buckets and providers without native move, a "move" is a server-side copy followed by a delete of the source, two separate operations that are not atomic. This introduces failure modes:

1. **Copy succeeds, delete fails**: The blob exists at both the temporary and final paths. The temporary object becomes an orphan, cleaned up by upload purging (see [Blob Lifecycle](#blob-lifecycle) step 5). No data loss or corruption. The final object is correct.
2. **Copy fails**: The upload fails. The client receives an error and must retry. The temporary object remains at the upload path and is eventually cleaned up by purging if the client abandons the session. There is no partial-success state: the blob either exists at the final content-addressable path or it does not.
3. **Concurrent completion**: If the destination already exists (another upload of the same content completed first), the copy is skipped entirely. The source is deleted and a reference is added to the existing blob.

On the copy+delete path, GCS and S3 handle delete-after-copy failures differently: GCS swallows delete errors silently, while S3 propagates them to the caller. We normalize this behavior: a failed delete after successful copy is non-fatal on all backends. The blob is at the destination; the orphaned source at the upload path is handled by upload purging (see [Blob Lifecycle](#blob-lifecycle) step 5). This means move error handling is identical regardless of storage backend, so callers do not branch on provider-specific failure modes.

For same-bucket, same-region operations (guaranteed by the [intra-partition upload path design](#upload-path-structure)), server-side copies are fast and do not transfer data through the client.

The move semantics described here depend on strong read-after-write consistency: a successful copy must be immediately visible to subsequent reads. All [officially supported object storage providers](https://docs.gitlab.com/administration/object_storage/#object-storage-provider-support) (AWS S3, GCS, Azure Blob Storage) provide this guarantee. S3-compatible backends that are not officially supported (for example, Ceph RadosGW) may have weaker consistency for certain operations, which could cause incorrect deduplication behavior during concurrent uploads.

S3's `CopyObject` API supports objects up to 5 GB. Artifacts larger than this threshold (for example, ML models, large container layers) require multipart server-side copy (`UploadPartCopy`). The specific implementation is storage-driver-dependent and outside the scope of this ADR, but the move step must handle arbitrarily sized blobs. Multipart copies introduce additional intermediate states (partially copied parts) beyond the failure modes described above; these are storage-driver-specific and resolved at the driver level.

#### Concurrent Uploads of Identical Content

When two clients upload the same content simultaneously, each upload is tracked independently:

1. Both clients create independent database upload session records with unique `upload_id` values.
2. Both write to independent temporary paths (`uploads/{uuid_a}` and `uploads/{uuid_b}`).
3. Both compute the same SHA256 hash during streaming write.
4. The first to complete moves (copies) to `objects/{hash_path}`, creates the blob record, and adds a reference.
5. The second to complete finds the destination already exists, skips the copy, deletes its temporary object, and adds its own reference to the existing blob.
6. Both upload session rows are independently deleted from the database.

Each session has its own lifecycle: independent tracking, independent cleanup. Deduplication happens at the move step as a structural consequence of content-addressable paths, not as a coordination step between uploads.

The storage-level deduplication check (step 4-5 above) and the database-level reference creation are not atomic with respect to each other. If the first upload has copied to the destination but not yet committed its blob record, the second upload sees the destination exists in storage but has no blob record to reference. <!-- [ADR-007](007_database_schema.md) --> ADR-007 must address this with appropriate uniqueness constraints, upsert semantics, or retry strategies to ensure concurrent uploads resolve correctly at the database level.

#### Resumable Uploads and Hash State

At multi-GB artifact sizes (container layers, ML models), clients need the ability to resume interrupted uploads without re-uploading or re-hashing content already transferred. This requires persisting intermediate hash state between requests. For typical package uploads in the KB-MB range, clients complete uploads in a single request without needing resumable state, but the mechanism is available for all formats.

**We persist hash state in the database.** Hash state is stored in the `upload_sessions.hash_state` column (`BYTEA`, nullable) as serialized intermediate SHA-256 state.

The alternative is an object-storage sidecar at `uploads/{upload_id}/hashstates/{algorithm}/{offset}` (the container registry pattern). We reject it on cost: `upload_sessions.size_bytes` must already be kept current with the bytes acknowledged in object storage so the server can produce the `Range` response and resume correctly, so a single-row `UPDATE` against `upload_sessions` is unavoidable on the upload write path. Co-locating `hash_state` in that same `UPDATE` adds ~100 bytes (a marshaled SHA-256 state) to a write that is already partition-local under `HASH(namespace_id)`, and removes the two object-storage round-trips per chunk a sidecar requires (write on append, list-and-fetch on resume).

Concurrent writers and crash recovery use a **terminate-on-divergence** model rather than the container registry's silent re-hash fallback: `size_bytes` is authoritative, the database is never permitted to record an offset the backend has not durably received, and on resume a divergence between the recorded offset and the backend staging object terminates the session so the client restarts from scratch. Re-hash salvage is deliberately not adopted — it cannot certify the orphaned backend bytes (a correct-size-but-wrong-content risk) and would let silent corruption reach a content-addressed path; the `dirty` column ([ADR-007](007_database_schema.md)) is the forward-compatible hook for it. The full model — the cross-cutting invariants, the `size_bytes` compare-and-swap, the `dirty` poison pill, the DB-update granularity, and the per-failure recovery branches — is defined in the [Artifact Registry S06 storage-layer spec](https://gitlab.com/gitlab-org/ops/artifact-registry/-/blob/main/docs/specs/S06-storage-layer.md) "Consistency & Crash-Recovery Model".

The hash state lifecycle is tied to the upload session lifecycle: when the session row is deleted (on completion or purge), the hash state is deleted with it. The upload staging path (`uploads/{upload_id}`) contains only the blob data — no sidecar files.

#### Temporary Object Cleanup

On successful upload completion, the temporary object at `uploads/{upload_id}` is deleted as a best-effort operation immediately after the move to `objects/{content_hash}` and database session update. This applies to both the normal case (blob moved to destination) and the concurrent deduplication case (destination already exists, copy skipped). If the inline delete fails, no retry is attempted in the hot path. The blob has already been moved to the content-addressable store and recorded in the database, and the upload purger (see [Blob Lifecycle](#blob-lifecycle) step 5) handles it on the next sweep.

This means the purger's workload is limited to genuinely orphaned sessions (abandoned uploads, crashed clients) rather than the common case of successful completions.

#### Upload Session Tracking

Upload sessions are tracked in the database, not discovered through filesystem or object storage walks. Session schema and lifecycle management are defined in <!-- [ADR-007](007_database_schema.md) --> ADR-007.

### Read Path

Content-addressable storage allows the read path to derive the storage location directly from the content hash, with no database lookup needed to resolve a content hash to a storage path. Given a blob's SHA256 hash and namespace, the full object storage key is deterministic: `artifact_registry/{namespace_hash_shard}/objects/{content_hash_shard}` (abbreviated; see [Storage Path Strategy](#storage-path-strategy) for the full sharded layout).

This enables clients to verify integrity on download by computing the SHA256 hash of the received content and comparing it to the expected hash. Any mismatch indicates corruption or tampering in transit or at rest.

Content hashes also serve as natural cache keys. HTTP caching layers (CDN, reverse proxy) can cache blob responses keyed by content hash with long TTLs, since the content at a given hash is immutable. A different hash always means different content.

For virtual registries, content cached from upstream remotes follows the same CAS model: cached artifacts are stored at their content hash, so identical content fetched from different upstreams is naturally deduplicated. Because CAS keys on content rather than version path, mutable upstream versions (for example, Maven SNAPSHOTs) that change content produce a different hash and a new storage object. Cache invalidation and upstream freshness checking are API-level concerns defined in [ADR-009](009_api_design.md).

API-level read semantics (endpoint design, authentication, pre-signed URL generation) are also defined in [ADR-009](009_api_design.md).

### Blob Lifecycle

Content-addressable blobs follow a reference-counted lifecycle within each namespace:

1. **Upload**: Client uploads content to a temporary path (`uploads/{upload_id}`). The server computes the SHA256 hash by streaming the content through a hash function during the write.
2. **Deduplication check**: The move destination is determined by the content hash. If an object already exists at the destination path, the blob is a duplicate, so no new object is written to storage and the temporary upload is discarded. If the path is empty, the blob is moved from the temporary path to the final location. This is a storage-level operation. No database coordination is needed for the deduplication check itself (see [Storage Path Strategy](#storage-path-strategy)).
3. **Reference tracking**: Multiple registries and repositories within the same namespace can reference the same physical blob. Reference tracking schema and query patterns are defined in <!-- [ADR-007](007_database_schema.md) --> ADR-007.
4. **Dereference**: When an artifact is deleted or a lifecycle policy removes a version, the corresponding reference is removed. The blob itself is not deleted from storage at this point.
5. **Orphaned upload purging**: Uploads that are never completed (client crash, network failure, abandoned session) leave objects in the `uploads/` path. A background process queries the database for upload sessions past their expiry and deletes the corresponding storage objects. This runs as a coordinated job (not per-instance), avoiding the [redundant sweep problem](https://gitlab.com/gitlab-org/container-registry/-/issues/217) the container registry encountered. Because sessions are database-tracked, purging does not require enumerating objects in storage. It queries a bounded set of expired records, avoiding the [memory scaling problem](https://gitlab.com/gitlab-org/container-registry/-/issues/216) of loading all candidates at once.
6. **Garbage collection**: A background process periodically identifies blobs with zero remaining references and deletes them from object storage. GC operates within a single namespace boundary, so no cross-namespace coordination is needed (see [ADR-022](022_namespace_decoupling.md)). GC deletes storage objects before removing database records, so the worst case is orphaned storage (wasted space), not dangling database references (broken pulls). The mechanism for preventing races between garbage collection and concurrent uploads (for example, grace periods, reference locking) is defined in <!-- [ADR-007](007_database_schema.md) --> ADR-007.

## Consequences

### Positive

1. **Immutable content**: Content-addressable storage keeps artifacts immutable. Once we store content at a hash-based location, any modification produces a different hash and thus a different storage location, preventing tampering

2. **Cryptographic integrity verification**: SHA256 hashes let clients verify artifact integrity by comparing computed hash with expected hash, detecting corruption or tampering during download

3. **Upload optimization**: Before uploading, clients check if content already exists by hash, skipping redundant uploads of identical content

4. **Cross-repository blob sharing**: Within a namespace, referencing a blob that already exists in another repository is a database-only operation, with no data transfer. If the blob already exists at the content-addressable path, a new reference is added without copying storage objects. For container registries, this enables the OCI `mount` operation (cross-repository blob mounting). For package registries, this means identical artifacts published to multiple projects (for example, shared internal libraries) are stored once per namespace. In both cases, the storage location is determined by the content hash, not the repository.

5. **Simplified concurrent uploads**: Multiple concurrent uploads of identical content naturally converge to the same storage location without conflicts

6. **Content-based caching**: HTTP caching layers use content hashes as cache keys, enabling efficient CDN and proxy caching strategies

### Negative

1. **Hash calculation overhead**: Every upload computes the SHA256 hash of the entire content. Streaming computation (hashing during write) mitigates latency, but CPU cost remains proportional to content size

2. **Two-phase upload complexity**: Uploads go to a temporary location first, compute hash, then move to the final content-addressable path, adding implementation complexity

3. **Non-atomic move on some object storage backends**: For S3 standard buckets and providers without native move, the move from temporary to final path is a server-side copy followed by a delete, which is not atomic. Failure between copy and delete leaves orphaned temporary objects. GCS provides an [atomic move](https://cloud.google.com/storage/docs/json_api/v1/objects/move) that eliminates this for GitLab.com, but the system still depends on a background upload purger for other backends; if the purger falls behind or fails, orphaned storage accumulates silently

4. **Reference tracking risk**: The blob lifecycle depends on accurate reference tracking across registries and repositories within a namespace. Bugs in reference tracking can cause premature garbage collection (data loss) or blobs that are never collected (storage leaks). This is a correctness-critical component

5. **Cross-namespace duplication**: Namespace-scoped deduplication means identical blobs uploaded to different namespaces within the same organization are stored separately. This is an explicit tradeoff for isolation and operational simplicity (see [ADR-022](022_namespace_decoupling.md))

6. **Database-storage divergence**: The system maintains two sources of truth: blob records in the database and objects in storage. These can diverge (for example, a crash between the storage write and database commit leaves an orphaned object in `objects/` that no database record references). Reconciliation requires a separate process

7. **Database lookups required**: Each upload operation requires database queries for reference tracking and session management, even though the deduplication check itself is storage-level

## Alternatives

### Alternative 1: Instance-Wide Content-Addressable Storage

Use CAS with SHA256 but deduplicate across all organizations on the instance, storing identical content once globally.

**Pros:** Instance-wide deduplication stores identical blobs across organizations only once, reducing total object count.

**Cons:**

- **Cross-organization reference counting**: Deleting a blob requires checking references across all organizations, creating unbounded query scope
- **Security risk**: Shared blob references reveal what content other organizations use (content existence oracle)
- **Cost attribution complexity**: Storage costs must be split across organizations using shared blobs
- **GC coordination**: Garbage collection blocked by cross-organization dependencies. The container registry's [operational experience](https://gitlab.com/gitlab-org/container-registry/-/issues/1242) with instance-wide deduplication demonstrates these problems at scale
- **Disaster recovery coupling**: Restoring one organization may require blobs referenced by other organizations

**Why rejected:** Analysis shows only low single-digit savings over namespace-scoped deduplication (see [ADR-002](002_storage_deduplication_scope.md)). The operational complexity and security risks outweigh the marginal storage benefit.

### Alternative 2: No Deduplication (Simple Storage)

Store every artifact upload as a separate object without content hashing or deduplication.

**Pros:**

- Simplest implementation: no hash computation, no reference counting, no deduplication coordination
- No two-phase upload needed: content goes directly to final storage location
- No GC complexity: deleting an artifact deletes its storage object directly

**Cons:**

- **~36%+ storage overhead** compared to namespace-scoped deduplication for container images (based on [container registry analysis](https://gitlab.com/gitlab-com/content-sites/handbook/-/merge_requests/17524#note_3023542021) at the repository level). Package registries have lower dedup ratios because artifacts are typically unique per version, but integrity verification and upload optimization remain valuable regardless of dedup ratio.
- **No integrity verification**: Without content hashing, corruption or tampering during transit goes undetected unless clients implement their own verification
- **Unfair billing**: Customers pay for duplicate storage of identical content across repositories
- **No upload optimization**: Clients cannot skip uploads of already-stored content
- **Uncompetitive**: JFrog Artifactory uses [checksum-based storage](https://jfrog.com/help/r/jfrog-installation-setup-documentation/checksum-based-storage) as a core feature, deduplicating identical binaries across all repositories. Lacking deduplication would be a competitive disadvantage against the market leader in this space

**Why rejected:** The storage overhead and lack of integrity verification are unacceptable for an enterprise product competing with established artifact registries. CAS is an industry-standard approach for this problem space.

## References

- [ADR-002: Storage Deduplication Scope](002_storage_deduplication_scope.md) - Detailed decision on deduplication scope
- [ADR-022: Namespace Decoupling](022_namespace_decoupling.md) - Namespace abstraction, deduplication boundary shift to namespace scope
- [ADR-007: Database Schema](007_database_schema.md) - Registry root table and database schema
- [Storage Inefficiency Analysis](https://gitlab.com/groups/gitlab-org/-/epics/13120#note_1874046581) - Shows ~95% of images are not shared across top-level namespaces
- [Container Registry Deduplication Complexity](https://gitlab.com/gitlab-org/container-registry/-/issues/1242)
- [Container Registry Blob Upload Implementation](https://gitlab.com/gitlab-org/container-registry/-/blob/master/registry/storage/blobwriter.go) - Production-hardened reference for move-based two-phase upload with streaming hash computation
- [GitLab Hashed Storage](https://gitlab.com/groups/gitlab-org/-/work_items/2320) - GitLab's migration from human-readable to hashed storage paths
- [Geo Sync for Container Registry Rename/Move](https://gitlab.com/gitlab-org/gitlab/-/issues/495147) - Illustrates operational cost of human-readable storage paths in distributed systems
- [Container Registry Upload Purging Memory Issue](https://gitlab.com/gitlab-org/container-registry/-/issues/216) - Filesystem-based upload tracking loaded all candidates into memory
- [Container Registry Upload Purging Scaling Issue](https://gitlab.com/gitlab-org/container-registry/-/issues/217) - Per-instance upload sweeps caused redundant work at scale
- [GitLab Object Storage Provider Support](https://docs.gitlab.com/administration/object_storage/#object-storage-provider-support) - Officially supported object storage backends and consistency guarantees
- [Cells Design Document](../../cells/)
