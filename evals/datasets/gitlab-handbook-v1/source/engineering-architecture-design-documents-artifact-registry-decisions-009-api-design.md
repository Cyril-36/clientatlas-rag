---
slug: engineering-architecture-design-documents-artifact-registry-decisions-009-api-design
title: "Artifact Registry ADR 009: API Design"
source_url: "https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/artifact_registry/decisions/009_api_design/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
title: "Artifact Registry ADR 009: API Design"
owning-stage: "~devops::package"
description: "Decision on the API endpoints organization for the registry"
toc_hide: true
---

## Context

The Artifact Registry requires a comprehensive API design with the following constraints:

1. **Three API categories**: Management APIs to interact with registry concepts, Artifact Management Client APIs that follow strict specifications to be used by specific clients, and a GitLab API for platform-to-registry communication.
2. **Follow the database data organization**: The API endpoints are organized by artifact format, matching the database schema <!-- (see [ADR-007](007_database_schema.md)) --> where repositories have tables and fields per format family (`docker` and `oci` share the `container_*` tables). This mapping simplifies implementation by avoiding complex multi-format abstractions and enables format-specific optimizations.
3. **Three repository types**: The registry supports three repository types — hosted (private storage for pushed artifacts), remote (proxy/cache for external registries), and virtual (aggregated pull endpoint combining hosted and remote upstreams). This model matches industry practice. All three types are standalone, independently manageable entities.

The Artifact Registry is scoped to Organizations (see [ADR-001](001_organizations_as_anchor_point.md) for rationale) through an immutable, customer-chosen slug ([ADR-022](022_namespace_decoupling.md)) that appears in all customer-facing URLs. All client and management endpoints include the `/:slug` path segment after the API version prefix (or protocol prefix for client APIs), scoping every request to a specific slug. The slug provides stable [Cells](../../cells/) routing via the topology service without depending on organization path resolution. Two exceptions: the OCI-mandated `GET /v2/` version probe (see [Container](#container)) and the GitLab API endpoints (see [GitLab API](#gitlab-api)).

The Artifact Registry is served on a dedicated domain (for example, `artifact-registry.gitlab.com`), separate from the main GitLab application domain. This drastically improves our security posture against [XSS](https://owasp.org/www-community/attacks/xss/) and [SSRF](https://owasp.org/www-community/attacks/Server_Side_Request_Forgery) vulnerabilities by isolating the registry from the main application's cookies, credentials, and internal network context.

This ADR defines the API surfaces, the rules that apply to them, and the endpoint structure. Request and response payloads live in the corresponding OpenAPI specifications in the Artifact Registry codebase.

### Versioning

The Artifact Registry runs on a dedicated domain, so the `/api/v4` prefix used in the GitLab Rails monolith does not apply. The monolith uses `/api/v4` to separate API routes from web UI routes on the same domain and to reflect its API version lineage (v3 to v4). Neither concern exists for a standalone service.

Management API routes use an `/api/v1` path-based version prefix. The `/api/` prefix separates management routes from protocol-specific client routes on the same domain, preventing namespace collisions if the management API version is ever bumped (e.g., OCI mandates `/v2/`, so a bare `/v2` management prefix would collide). This is consistent with industry practice. Path-based versioning keeps the version visible in URLs, logs, and routing rules without requiring header inspection.

Client APIs do not use a version prefix. Protocol-specific versioning is handled by the clients themselves if necessary (e.g., OCI mandates `/v2/`). This keeps client-configured URLs as short as possible.

GitLab API routes use an `/api/gitlab/v1` prefix. The explicit `gitlab` segment keeps the surface visible in URLs, logs, and routing rules, and lets the edge apply dedicated path rules to it. This follows the Container Registry precedent, whose registry-to-platform surface uses a `/gitlab/v1/` prefix.

### API Classification

The API surface is divided into three distinct categories which have different rules:

1. **Management APIs**: REST and GraphQL APIs for CRUD operations on registry concepts (repositories, artifacts, policies, etc.)
   - Authentication: GitLab's standard REST/GraphQL authentication
   - Purpose: UI, automation scripts, administrative tools
   - Format: JSON responses with standard GitLab API patterns
   - Pagination: All list endpoints are paginated, preferably using a keyset pagination strategy

2. **Artifact Management Client APIs**: Protocol-specific APIs implementing industry-standard specifications
   - Authentication: Protocol-specific (Bearer tokens for OCI, Basic auth for Maven, etc.)
   - Purpose: Native client compatibility (`docker`, `npm`, `mvn` commands)
   - Format: Protocol-specific responses (OCI Distribution Spec, Maven Repository Layout, NPM Registry API)

3. **GitLab API**: REST endpoints for platform-to-registry communication
   - Authentication: Service-to-service credentials; no end-user identity
   - Purpose: Namespace provisioning, resolution, and service conditions; resource verifications
   - Format: JSON
   - Exposure: Trusted platform callers only

Management and Client APIs serve all three repository types: hosted, virtual, and remote. Client APIs are organized per protocol (one set of endpoints per protocol; the OCI Distribution Spec endpoints serve repositories of both the `docker` and `oci` formats), while Management APIs share a unified repository CRUD with format appearing only in format-specific sub-resources.

### URL Structure Design

Management API routes are **anchored at the repository**. The `/api/v1/:slug` prefix is mandatory for all routes and is not counted as a conceptual level. Repository endpoints accept a unique repository name as the `:repository_name` parameter.

All repository-level resources (artifacts, lifecycle policies, upstream associations) are scoped to a repository because hosted and remote repositories store data in separate, per-format-family tables.

The `:format` segment appears **after a repository** for all format-specific sub-resources: `/api/v1/:slug/repositories/:repository_name/:format/...` (e.g., listing images, lifecycle policies). Repository-level sub-resources are dedicated to a specific format, allowing higher flexibility in endpoints organization and customization of the returned structure. This includes both artifact operations and format-specific configuration. Namespace-level format-specific operations use `:format` as a prefix: `/api/v1/:slug/:format/statistics`.

Repository CRUD itself is format-free because the `repositories` parent table is shared across all formats and types. Format and kind are properties of the repository resource, not URL segments.

For example:

- Listing all repositories: `GET /api/v1/:slug/repositories`
- Creating a repository: `POST /api/v1/:slug/repositories`
- Reading/updating/deleting a repository: `GET/PATCH/DELETE /api/v1/:slug/repositories/:repository_name` (top-level route using the target concept identifier)
- Listing images in a container-family repository: `GET /api/v1/:slug/repositories/:repository_name/:format/images` (format-specific sub-resource; `:format` is `docker` or `oci`)
- Getting an image by ID: `GET /api/v1/:slug/repositories/:repository_name/:format/images/:image_id` (artifact detail, scoped to the repository)

### Repository Name Immutability

Repository names are set at creation time and cannot be changed. Repository descriptions remain mutable. This prevents broken client configurations, authorization bypass through name reclaim, and silent misrouting. It also enables name-based URLs (see [below](#human-friendly-urls)) and simplifies authorization rules.

This is consistent with industry practice. See [gitlab-org/gitlab#592582](https://gitlab.com/gitlab-org/gitlab/-/issues/592582) for more details.

### Human-Friendly URLs

Repository endpoints accept a unique name as the identifier. Repository names must be globally unique within the slug, regardless of format or repository type. This global uniqueness constraint matches industry practice and avoids ambiguous name-based lookups. It can be relaxed to per-format uniqueness later without breaking anyone; tightening would be a breaking change. Name immutability (see [above](#repository-name-immutability)) makes name-based URLs safe as stable path segments. Slugs are immutable ([ADR-022](022_namespace_decoupling.md)), so every segment in a URL path is human-readable and permanently stable.

## API Organization

### Management APIs

Management APIs use GitLab [REST API authentication](https://docs.gitlab.com/api/rest/authentication/).

**Note:** `:format` represents the repository's `format` value (`docker`, `oci`, `maven`, or `npm`). The `docker` and `oci` formats form the container family: they share the container artifact model (images, tags, manifests) and the `container_*` tables. A request whose `:format` segment does not match the repository's format returns `404 Not Found`.

#### Namespace-level APIs

**Repository Management:**

- `GET    /api/v1/:slug/repositories`                  - List all repositories (hosted, virtual, and remote across all formats). Supports filtering by format and repository type
- `POST   /api/v1/:slug/repositories`                  - Create a repository
- `GET    /api/v1/:slug/repositories/:repository_name` - Get repository details
- `PATCH  /api/v1/:slug/repositories/:repository_name` - Update a repository
- `DELETE /api/v1/:slug/repositories/:repository_name` - Delete a repository

The repository detail response is polymorphic — its shape varies by format and kind:

- All repositories return common fields from the parent `repositories` table: `name`, `format`, `kind`, `visibility`, `description`, counters (`artifacts_count`, `downloads_count`, `size_bytes`), and `last_updated_at`.
- Format-specific and kind-specific fields are nested under a single `settings` object rather than appearing as optional top-level keys. The `format` and `kind` fields act as discriminators — clients use them to interpret the shape of `settings`.
- `POST` and `PATCH` accept the same nested structure for create and update operations.

**Statistics:**

- `GET /api/v1/:slug/statistics`         - Get aggregate storage and download statistics
- `GET /api/v1/:slug/:format/statistics` - Get storage and download statistics for a specific format

**Lifecycle Policies:**

- `GET    /api/v1/:slug/lifecycle_policy`                - Get the lifecycle policy
- `PATCH  /api/v1/:slug/lifecycle_policy`                - Update the lifecycle policy
- `GET    /api/v1/:slug/lifecycle_policy/rules`          - Get lifecycle policy rules
- `POST   /api/v1/:slug/lifecycle_policy/rules`          - Create a lifecycle policy rule
- `GET    /api/v1/:slug/lifecycle_policy/rules/:rule_id` - Get a lifecycle policy rule
- `PATCH  /api/v1/:slug/lifecycle_policy/rules/:rule_id` - Update a lifecycle policy rule
- `DELETE /api/v1/:slug/lifecycle_policy/rules/:rule_id` - Delete a lifecycle policy rule

#### Repository-level APIs

**Virtual Repository - Upstreams:**

Upstreams are stored in per-format-family tables (`container_virtual_repository_upstreams`, shared by `docker` and `oci`, plus `maven_virtual_repository_upstreams` and `npm_virtual_repository_upstreams`) with format-specific upstream rules. Since remote and hosted repositories are standalone entities, virtual repository upstreams are references to existing repositories. The upstream type (hosted or remote) is determined by the referenced repository's `kind`.

- `GET    /api/v1/:slug/repositories/:repository_name/:format/upstream_repositories`     - List upstream repositories (hosted and remote) for a virtual repository, ordered by resolution priority
- `POST   /api/v1/:slug/repositories/:repository_name/:format/upstream_repositories`     - Associate a repository (hosted or remote) as an upstream of a virtual repository. Accepts `upstream_repository_id`
- `GET    /api/v1/:slug/repositories/:repository_name/:format/upstream_repositories/:id` - Get an upstream repository association
- `PATCH  /api/v1/:slug/repositories/:repository_name/:format/upstream_repositories/:id` - Update association position. Only the `position` field can be updated
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/upstream_repositories/:id` - Disassociate an upstream from a virtual repository

**Remote Repository - Connection Test:**

- `POST /api/v1/:slug/repositories/:repository_name/test` - Test connection to the configured remote registry

**Statistics:**

- `GET    /api/v1/:slug/repositories/:repository_name/statistics`  - Get repository storage and download statistics

**Lifecycle Policies:**

Repository-level lifecycle policies use per-format-family tables (`container_repository_lifecycle_policy_settings`, etc.) that override the namespace-level defaults.

- `GET    /api/v1/:slug/repositories/:repository_name/:format/lifecycle_policy`                - Get the lifecycle policy for the repository
- `PATCH  /api/v1/:slug/repositories/:repository_name/:format/lifecycle_policy`                - Update the lifecycle policy for the repository
- `GET    /api/v1/:slug/repositories/:repository_name/:format/lifecycle_policy/rules`          - Get the lifecycle policy rules for the repository
- `POST   /api/v1/:slug/repositories/:repository_name/:format/lifecycle_policy/rules`          - Create a lifecycle policy rule for the repository
- `GET    /api/v1/:slug/repositories/:repository_name/:format/lifecycle_policy/rules/:rule_id` - Get a lifecycle policy rule
- `PATCH  /api/v1/:slug/repositories/:repository_name/:format/lifecycle_policy/rules/:rule_id` - Update a lifecycle policy rule
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/lifecycle_policy/rules/:rule_id` - Delete a lifecycle policy rule

#### Format-Specific Artifact APIs

All artifact endpoints are scoped to the repository and apply uniformly to both hosted and remote repositories: routes, verbs, and pagination are identical for both kinds. Remote repositories cache artifacts in hierarchical tables (`*_remote_images`, `*_remote_packages`, `*_remote_versions`, `*_remote_files`, etc.) that mirror the hosted schema (see [ADR-007](007_database_schema.md)).

The response body is polymorphic by repository `kind` — the same convention used for the [repository-detail `settings` object](#namespace-level-apis). When `kind` is `remote`, each entry that maps to a freshness-tracked row (tags, package files, metadata files) carries a nested `cache` object exposing `upstream_checked_at` and `upstream_etag`. Container manifests and blobs are content-addressed by digest and do not carry per-row freshness, so they have no `cache` block. Repository-level cache configuration (`cache_validity_hours`, `metadata_cache_validity_hours`) lives in the repository-detail `settings` object and is not echoed per artifact. A request against a hosted repository returns the same shape _without_ the `cache` object.

Verb semantics on a remote repository describe the cached row, not the upstream:

- `DELETE` evicts the cached row (no upstream effect; the artifact is re-fetched on the next pull through the client API).
- `PATCH .../quarantine` flags the cached row as blocked: client pulls return `404 Not Found` even if upstream still has the artifact. The flag is bound to the cached row's lifecycle — eviction clears it. Persistent or digest-level blocks are deliberately out of scope (a lifecycle-management concern, not an API one).
- `GET` is identical for both kinds modulo the `cache` sub-object described above.

**Container-family-specific - Images:**

For container-family repositories, artifacts are called "images". The `:format` segment in these routes is the repository's format, `docker` or `oci`:

- `GET    /api/v1/:slug/repositories/:repository_name/:format/images`                      - List images in a repository
- `GET    /api/v1/:slug/repositories/:repository_name/:format/images/:image_id`            - Get image details
- `GET    /api/v1/:slug/repositories/:repository_name/:format/images/:image_id/manifests`  - List manifests for the given image
- `GET    /api/v1/:slug/repositories/:repository_name/:format/images/:image_id/blobs`      - List blobs for the given image
- `GET    /api/v1/:slug/repositories/:repository_name/:format/images/:image_id/statistics` - Get image storage, usage, and download statistics
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/images/:image_id`            - Delete an image (soft or hard delete)
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/images`                      - Delete images in bulk
- `PATCH  /api/v1/:slug/repositories/:repository_name/:format/images/:image_id/quarantine` - Quarantine the given image

**Container-family-specific - Image Tags:**

- `GET    /api/v1/:slug/repositories/:repository_name/:format/images/:image_id/tags`                 - List tags for the given image
- `GET    /api/v1/:slug/repositories/:repository_name/:format/images/:image_id/tags/:tag/statistics` - Get tag storage, usage, and download statistics
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/images/:image_id/tags/:tag`            - Delete an image tag
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/images/:image_id/tags`                 - Delete a set of image tags

**Maven/NPM-specific - Packages:**

- `GET    /api/v1/:slug/repositories/:repository_name/:format/packages`                         - List packages in a repository
- `GET    /api/v1/:slug/repositories/:repository_name/:format/packages/:package_id`             - Get package details
- `GET    /api/v1/:slug/repositories/:repository_name/:format/packages/:package_id/statistics`  - Get package storage, usage, and download statistics
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/packages/:package_id`             - Delete a package (soft or hard delete)
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/packages`                         - Delete packages in bulk
- `PATCH  /api/v1/:slug/repositories/:repository_name/:format/packages/:package_id/quarantine`  - Quarantine the given package
- `GET    /api/v1/:slug/repositories/:repository_name/:format/packages/:package_id/versions`    - List versions for the given package

**Maven/NPM-specific - Package Versions:**

- `GET    /api/v1/:slug/repositories/:repository_name/:format/versions/:version_id`            - Get version details
- `GET    /api/v1/:slug/repositories/:repository_name/:format/versions/:version_id/statistics` - Get package version storage, usage, and download statistics
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/versions/:version_id`            - Delete a version (soft or hard delete)
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/versions`                        - Delete versions in bulk
- `GET    /api/v1/:slug/repositories/:repository_name/:format/versions/:version_id/files`      - List files for the given version

**Maven/NPM-specific - Package Files:**

- `GET    /api/v1/:slug/repositories/:repository_name/:format/files/:file_id`          - Get file details
- `GET    /api/v1/:slug/repositories/:repository_name/:format/files/:file_id/download` - Download a file
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/files/:file_id`          - Delete a file (soft or hard delete)
- `DELETE /api/v1/:slug/repositories/:repository_name/:format/files`                   - Delete files in bulk

**NPM-specific - Distribution Tags:**

- `GET    /api/v1/:slug/repositories/:repository_name/npm/packages/:package_id/tags` - List tags for the given package
- `GET    /api/v1/:slug/repositories/:repository_name/npm/tags/:tag_id`              - Get tag details
- `GET    /api/v1/:slug/repositories/:repository_name/npm/tags/:tag_id/statistics`   - Get tag storage, usage, and download statistics
- `DELETE /api/v1/:slug/repositories/:repository_name/npm/tags/:tag_id`              - Delete a tag

### Artifact Management Client APIs

Client API URLs are the same for all repository types (hosted, remote, virtual). The registry resolves the repository kind internally and applies type-specific behavior (e.g., rejecting writes on remote and virtual repositories).

#### Container

Implements [OCI Distribution Spec v1.1](https://github.com/opencontainers/distribution-spec/blob/main/spec.md). Authentication: [Bearer token](https://docs.docker.com/reference/api/registry/auth/).

The literal `container` path segment below is fixed at the protocol level: one set of `/v2` endpoints serves repositories of both the `docker` and `oci` formats. It is a router-injected literal, not the repository's `format` value (see [Management APIs](#management-apis)).

- `GET    /v2/`                                                                                   - Check API version and registry implementation (OCI-mandated, not scoped to a slug)
- `GET    /v2/:slug/container/:repository_name/:image_name/manifests/:reference`                  - Get manifest (reference can be tag or digest)
- `HEAD   /v2/:slug/container/:repository_name/:image_name/manifests/:reference`                  - Check manifest existence
- `PUT    /v2/:slug/container/:repository_name/:image_name/manifests/:reference`                  - Upload manifest (not available for remote and virtual repositories)
- `DELETE /v2/:slug/container/:repository_name/:image_name/manifests/:reference`                  - Delete manifest (by digest or tag reference, not available for remote and virtual repositories)
- `DELETE /v2/:slug/container/:repository_name/:image_name/manifests/:tag`                        - Delete a specific tag (not available for remote and virtual repositories)
- `GET    /v2/:slug/container/:repository_name/:image_name/blobs/:digest`                         - Download blob
- `HEAD   /v2/:slug/container/:repository_name/:image_name/blobs/:digest`                         - Check blob existence
- `DELETE /v2/:slug/container/:repository_name/:image_name/blobs/:digest`                         - Delete blob (not available for remote and virtual repositories)
- `POST   /v2/:slug/container/:repository_name/:image_name/blobs/uploads/`                        - Initiate blob upload (not available for remote and virtual repositories)
- `PATCH  /v2/:slug/container/:repository_name/:image_name/blobs/uploads/:uuid`                   - Upload blob chunk (not available for remote and virtual repositories)
- `GET    /v2/:slug/container/:repository_name/:image_name/blobs/uploads/:uuid`                   - Get blob upload status (for resumable uploads, not available for remote and virtual repositories)
- `PUT    /v2/:slug/container/:repository_name/:image_name/blobs/uploads/:uuid?digest=:digest`    - Complete blob upload (not available for remote and virtual repositories)
- `DELETE /v2/:slug/container/:repository_name/:image_name/blobs/uploads/:uuid`                   - Cancel blob upload (not available for remote and virtual repositories)
- `POST   /v2/:slug/container/:repository_name/:image_name/blobs/uploads/?digest=:digest`         - Upload complete blob in single request (not available for remote and virtual repositories)
- `GET    /v2/:slug/container/:repository_name/:image_name/tags/list`                             - List all tags in repository
- `GET    /v2/:slug/container/:repository_name/:image_name/tags/list?n=100&last=tag_name`         - Paginated tag listing
- `GET    /v2/:slug/container/:repository_name/:image_name/referrers/:digest`                     - List artifacts/attestations referencing a manifest
- `GET    /v2/:slug/container/:repository_name/:image_name/referrers/:digest?artifactType=<type>` - Filter referrers by artifact type

**Note:** The OCI-mandated `GET /v2/` endpoint does not include a `/:slug` prefix, which means the [Cells](../../cells/) router cannot determine which Cell should handle the request from the path alone. Any Cell can serve `GET /v2/` because it is a stateless version probe (`200 OK` to indicate OCI compliance, otherwise `401 Unauthorized`); no slug or routing context is needed. All other client requests carry a `/:slug` segment that the Cells router uses to determine the target Cell — clients obtain credentials client-side via [`glab`](https://gitlab.com/gitlab-org/cli) (see [ADR-020](020_authentication_flow.md)) and present a Bearer token from the start, so the OCI `401 WWW-Authenticate` redirect challenge is not used. `GET /v2/_catalog` (Docker Registry HTTP API V2) is not part of the OCI Distribution Spec and will not be implemented.

##### Client configuration example

Pulling an image from a container-family repository named `my-repo` with image name `my-app` and tag `latest`, with slug `acme-engineering`:

```shell
docker pull artifact-registry.gitlab.com/acme-engineering/container/my-repo/my-app:latest
```

#### Maven

Implements [Maven Repository Layout](https://maven.apache.org/repositories/layout.html). Authentication: Basic auth. Custom header authentication (a legacy mechanism from the original GitLab Maven package registry) is not supported. Basic auth is the universal standard across Maven registries and is supported by all major build tools (`mvn`, `gradle`, `sbt`). Notably, `sbt` only supports basic auth.

- `GET /:slug/maven/:repository_name/*path/:file_name` - Download a package file from a Maven hosted, remote or virtual repository
- `PUT /:slug/maven/:repository_name/*path/:file_name` - Upload a package file to a Maven hosted repository (not available for remote and virtual repositories)

##### Client configuration example

Repository URL for a Maven repository named `my-repo` with slug `acme-engineering`, used in `settings.xml`, `build.gradle`, or `build.sbt`:

```plaintext
https://artifact-registry.gitlab.com/acme-engineering/maven/my-repo
```

#### NPM

Implements [NPM Registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md). Authentication: Bearer token.

- `GET    /:slug/npm/:repository_name/:package_name`                                 - Get package metadata
- `PUT    /:slug/npm/:repository_name/:package_name`                                 - Publish a package (not available for remote and virtual repositories)
- `PUT    /:slug/npm/:repository_name/:package_name/-rev/:rev`                       - Unpublish a single version, step 1: replace the package document with the version removed (not available for remote and virtual repositories)
- `DELETE /:slug/npm/:repository_name/:package_name/-/:file_name/-rev/:rev`          - Unpublish a single version, step 2: delete the version tarball (not available for remote and virtual repositories)
- `DELETE /:slug/npm/:repository_name/:package_name/-rev/:rev`                       - Unpublish the entire package (`npm unpublish <pkg> --force`, not available for remote and virtual repositories)
- `GET    /:slug/npm/:repository_name/:package_name/-/:file_name`                    - Download a package file
- `GET    /:slug/npm/:repository_name/-/package/:package_name/dist-tags`             - List dist-tags for a package
- `PUT    /:slug/npm/:repository_name/-/package/:package_name/dist-tags/:tag`        - Create or update a dist-tag (not available for remote and virtual repositories)
- `DELETE /:slug/npm/:repository_name/-/package/:package_name/dist-tags/:tag`        - Delete a dist-tag (not available for remote and virtual repositories)
- `POST   /:slug/npm/:repository_name/-/npm/v1/security/audits/quick`                - Quick security audit
- `POST   /:slug/npm/:repository_name/-/npm/v1/security/advisories/bulk`             - Bulk security advisories

##### Client configuration example

Registry URL for an NPM repository named `my-repo` with slug `acme-engineering`, used in `.npmrc`:

```plaintext
https://artifact-registry.gitlab.com/acme-engineering/npm/my-repo/
```

### GitLab API

The GitLab API serves platform callers, initially the Rails monolith. Requests authenticate the calling service, never an end user: user checks belong to the platform flows that trigger the calls, and user-facing traffic uses the management and client APIs instead ([ADR-014](014_frontend_to_artifact_registry.md), [ADR-021](021_authorization.md)). "GitLab" names the caller: a GitLab platform deployment, in the hybrid deployment model a customer-hosted monolith, so the surface is internet-facing yet never customer-facing.

How callers authenticate to this surface, including in the hybrid deployment model (a Self-Managed or Dedicated monolith against the SaaS registry), is covered by [ADR-020](020_authentication_flow.md) and [ADR-021](021_authorization.md) ([artifact-registry#255](https://gitlab.com/gitlab-org/ops/artifact-registry/-/work_items/255)).

#### Namespace Lifecycle

These endpoints are slug-exempt: provisioning runs before a slug is claimed, resolution turns a UUID into the slug, and service conditions must work regardless of the slug's state. They reference namespaces by owner anchor ([ADR-001](001_organizations_as_anchor_point.md)) or UUID ([ADR-022](022_namespace_decoupling.md)):

- `POST /api/gitlab/v1/namespaces` - Provision a namespace for an owner anchor ([gitlab#603023](https://gitlab.com/gitlab-org/gitlab/-/work_items/603023)). Idempotent on the anchor; returns the namespace UUID, which the caller persists ([ADR-022](022_namespace_decoupling.md))
- `GET  /api/gitlab/v1/namespaces/:uuid` - Resolve a namespace by UUID; returns the owner anchor, slug, and status. Callers cache the slug and status ([ADR-022](022_namespace_decoupling.md), [ADR-014](014_frontend_to_artifact_registry.md))
- `POST /api/gitlab/v1/namespaces/:uuid/<action>` - Apply or lift a reversible service condition ([ADR-007](007_database_schema.md#namespaces)); one endpoint per action, where `<action>` is one of `block`, `unblock`, `disable`, `enable`, `suspend`, `unsuspend`

Slug-exempt routes do not weaken [Cells](../../cells/) routing. Namespace creation cannot be routed by key: nothing exists yet to route by. A cell-resident monolith calls its cell-local registry directly, and the namespace lands in that cell; a hybrid caller has no cell, so its call enters at the edge, which decides the target Cell. Both paths register the namespace UUID as a routing key (the slug is added as a second key when claimed). All other GitLab API endpoints are keyed by that UUID and route through the same topology mechanism as slug-prefixed requests, wherever the caller sits. If UUID-keyed routing ever proves insufficient, GitLab API requests can additionally embed the owner anchor as a routing hint, as previously explored for the Container Registry ([handbook!14825](https://gitlab.com/gitlab-com/content-sites/handbook/-/merge_requests/14825)); a potential path, not a current requirement.

#### Resource Verifications

Platform authorization flows must confirm that resources targeted by bulk role grants belong to a namespace ([artifact-registry#181](https://gitlab.com/gitlab-org/ops/artifact-registry/-/issues/181)). Namespace-targeted grants need no registry call: the platform verifies ownership against its persisted mapping ([gitlab#603023](https://gitlab.com/gitlab-org/gitlab/-/work_items/603023)). Repository-targeted grants use a batch verification, scoped by the namespace UUID and served from a single `HASH(namespace_id)` partition:

- `POST /api/gitlab/v1/namespaces/:uuid/repositories/verifications` - Batch-verify that the given repository ids exist under the namespace. Returns no data: `204` when all ids belong, one opaque `400` for every failure, never revealing whether an id exists

The registry returns no organization data: the caller supplies the namespace scope and already knows its owner. Future assignable resource types follow the same per-type pattern (`POST /api/gitlab/v1/namespaces/:uuid/<resource_type>/verifications`).

The GitLab API must stay backward compatible across the platform versions it serves: in the hybrid deployment model, a Self-Managed monolith can lag the SaaS registry ([ADR-022](022_namespace_decoupling.md)).

## Consequences

### Positive

- **Clear separation of concerns**: The three API surfaces have distinct purposes, authentication mechanisms, and target audiences, reducing confusion and enabling independent evolution
- **Repository-anchored URL patterns**: All artifact operations are scoped to the repository, providing clear routing context and enabling the same URL structure for both hosted and remote repositories
- **Permanently stable, human-readable URLs**: Slugs and repository names are both immutable, so every URL path segment is human-readable and never changes. No numeric IDs appear in any client-facing URL
- **Unified hybrid list**: A single endpoint lists all repositories (hosted, virtual, remote) across all formats with filtering, enabling a cross-format governance and auditability view for platform engineers
- **Remote repositories as standalone entities**: Remote repositories are independently manageable, reusable across multiple virtual repositories, and have their own lifecycle, matching industry practice (JFrog Artifactory, Sonatype Nexus, Google Cloud AR)
- **Uniform hosted and remote artifact structure**: Remote repositories use the same artifact hierarchy as hosted repositories (images, packages, versions, files). The same routes serve both kinds, with a nested `cache` sub-object surfacing freshness metadata (`upstream_checked_at`, `upstream_etag`) on the rows that track it. Cache mutation reuses the same verbs as hosted repositories (`DELETE` = evict, `PATCH .../quarantine` = block), so the API surface does not expand for remote repositories — only the response body is polymorphic
- **Simplified upstream model**: Virtual repository upstreams reference existing repositories by ID rather than using separate endpoint hierarchies per upstream type, reducing API surface and implementation complexity
- **Schema evolution outside the ADR**: Request and response payloads live in the OpenAPI specifications in the Artifact Registry codebase, so payload changes do not require ADR updates
- **Future extensibility**: The design pattern easily accommodates additional package formats (PyPI, NuGet, Helm, etc.) without architectural changes. Management and Client APIs can evolve independently based on their respective requirements

### Negative

- **Repository name immutability limits flexibility**: A typo or organizational rename requires creating a new repository and migrating artifacts rather than simply renaming
- **Global name uniqueness is restrictive**: Names like `my-app` cannot be reused across formats (e.g., a Docker and a Maven repo both called `my-app`), which may lead to naming conventions like `my-app-docker` and `my-app-maven`. This constraint can be relaxed later without breaking changes
- **Format-specific API surface**: Dedicating endpoints per format means some duplication across formats and no unified cross-format operations for management tasks

## References

- [ADR-001: Organizations as Anchor Point](001_organizations_as_anchor_point.md)
- [ADR-022: Namespace Decoupling](022_namespace_decoupling.md)
- [Cells Architecture](../../cells/)
- [Container Registry Routing Service (Cells)](https://gitlab.com/gitlab-com/content-sites/handbook/-/merge_requests/14825)
- [GitLab REST API Authentication](https://docs.gitlab.com/api/rest/authentication/)
- [OCI Distribution Spec v1.1](https://github.com/opencontainers/distribution-spec/blob/main/spec.md)
- [Docker Registry Bearer Token Authentication](https://docs.docker.com/reference/api/registry/auth/)
- [Maven Repository Layout](https://maven.apache.org/repositories/layout.html)
- [NPM Registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
- [Repository Name Immutability Proposal](https://gitlab.com/gitlab-org/gitlab/-/issues/592582)
