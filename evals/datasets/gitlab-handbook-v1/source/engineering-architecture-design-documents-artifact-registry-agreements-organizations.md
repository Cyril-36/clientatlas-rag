---
slug: engineering-architecture-design-documents-artifact-registry-agreements-organizations
title: "Artifact Registry and Organizations interface agreement"
source_url: "https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/artifact_registry/agreements/organizations/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
title: "Artifact Registry and Organizations interface agreement"
owning-stage: "~devops::package"
description: "Interface agreement between the Artifact Registry and Organizations teams"
toc_hide: true
---

<!-- vale gitlab.FutureTense = NO -->

## Summary

The Artifact Registry (AR) is the first organization-level GitLab feature. Organizations are the anchor point for AR's data partitioning, storage, billing, and access control. Decisions made here set precedent for future organization-level features.

This document defines the interface agreement between AR and Organizations: what AR requires, what AR provides, and which questions remain open. Discussions happen across time and mediums that are not easily trackable by everyone involved. A related decision made elsewhere is neither known nor accepted until persisted and approved in this document.

## Version history

| Version | Date | Author | Approved by | Summary |
| --- | --- | --- | --- | --- |
| 0.1 | 2026-04-06 | @jdrpereira | | Initial version |

## Timeline

AR is targeting .com go-live before the end of Q2 FY27 (July 31, 2026). SM and Dedicated onboarding is out of scope for Q2 launch; it depends on the unified self-service onboarding workflow targeted for Q3/Q4 FY27. The Organizations team has [descoped the Q2 Organization GA](https://gitlab.com/groups/gitlab-org/-/work_items/21393#note_3218405112) to the essentials needed for AR launch: organization confirmation before AR enablement, Organization object in the side panel, shell landing page (minimal page under the Organization object that AR populates with its own views). Admin area, settings, owner determination, and user management are deferred.

The MUST requirements in this document need to be met before AR can begin customer onboarding.

## Requirement levels

This document uses [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) keywords: **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** indicate requirement levels.

## Terminology

| Term | Definition |
| ------------------------ | -------------------------------------------------------------- |
| Organization | A GitLab entity above top-level groups (TLGs). The primary boundary for AR data partitioning, storage deduplication, cost attribution, and access control. |
| TLG | Top-level group. The highest-level group entity in the hierarchy. |
| Confirmed organization | An organization that has been verified to contain the correct TLGs. The confirmation mechanism is an [open question](#open-questions). |
| Namespace | An AR-internal entity scoped to an organization. An organization may have multiple namespaces. All data partitioning, storage, and access control are scoped to the namespace. See [Namespace Decoupling ADR](/handbook/engineering/architecture/design-documents/artifact_registry/decisions/022_namespace_decoupling/) for additional context. This is *not* related to the namespace entity on the monolith side. The latter is not relevant for this document. |
| Slug | An immutable, customer-facing identifier for an AR namespace. Appears in all AR URLs and client configurations. Unique within the GitLab SaaS boundary. Distinct from the organization path (`gitlab.com/o/<org-path>`), which is mutable and managed by the Organizations team. |
| Anchor tuple | `(platform, entity_type, entity_id)` stored in AR's `namespaces` table, linking a namespace to an external entity (organization). |

## Organization requirements

AR does not interpret organization membership, hierarchy, or lifecycle. AR receives an `organization_id` at namespace creation time and stores it in the anchor tuple. From that point forward, AR treats `organization_id` as opaque. AR ignores all other organization properties (name, path, membership, settings, plan).

No organization IDs or attributes appear in AR's public APIs or URLs. The `organization_id` is strictly internal, used for billing attribution but never exposed to clients.

### What AR provides

| Requirement | Level | Owner | Detail |
| ------------------------- | ------- | ------- | -------------------------------------------------------------- |
| Namespace resolution endpoint | MUST | AR | Returns the namespace details (slug, status) for a given namespace UUID. Rails persists the UUID at provisioning and caches the slug and status ([ADR-022](../decisions/022_namespace_decoupling.md#slug-discovery)). |
| Namespace creation API | MUST | AR | Management API creates an AR namespace linked to a confirmed organization and a customer-chosen slug. The response includes the namespace UUID, which Rails persists. |
| Transfer rule | MUST | AR | AR declares a transfer rule for organization merges. See [Merge trigger](#merge-trigger) for details. |
| Billing events | MUST | AR | AR emits usage events tagged with `organization_id` via Snowplow/LabKit SDK. The billing pipeline uses this for attribution. |

### Availability

AR requires an organization on all install types before a namespace can be created.

| Requirement | Level | Owner | Detail |
| ------------------------------------- | ------- | --------------- | -------------------------------------------------------------- |
| Available on all install types | MUST | Organizations | Organizations MUST be available on .com, Self-Managed, and Dedicated. |
| Single organization on SM/Dedicated | MUST | Organizations | Already rolled out ([Organizations ADR-007](/handbook/engineering/architecture/design-documents/organization/decisions/007_self_managed_dedicated_single_organization/)). Organization ID=1 on every SM/Dedicated instance. |

### TLG transfer

The Organizations team's eventual plan will transfer every .com TLG to its own organization (1:1). The organization contains the TLG without replacing or restructuring it. Customers will be able to combine these auto-provisioned organizations together, where they own multiple TLGs. AR does not prescribe this mapping.

| Requirement | Level | Owner | Detail |
| -------------------------- | -------- | --------------- | -------------------------------------------------------------- |
| Multi-TLG reconciliation on GitLab.com | SHOULD | Organizations | Customers with multiple TLGs SHOULD have a way to consolidate TLGs into a single organization before enabling AR. Reconciliation (moving TLGs into a pristine, unconfirmed organization) is distinct from organization merging (combining two active organizations with existing settings and features). Only reconciliation is needed in the near term. A [reconciliation POC](https://www.youtube.com/watch?v=HEfZzK4r9nQ) exists. See [Organization merges](#organization-merges) for the implications of not consolidating upfront. |

### Confirmation

AR MUST NOT be enabled on an unconfirmed organization. Confirmation is enforced on the Rails side: the namespace creation API MUST only be called after the organization is confirmed. AR trusts the caller and skips its own confirmation check.

| Requirement | Level | Owner | Detail |
| ---------------------------------------- | ------- | ---------------------------------- | -------------------------------------------------------------- |
| Confirmation before AR enablement | MUST | Organizations + AR + Fulfillment | The organization MUST be confirmed before AR can be enabled. For launch: manual process (org created, TLGs moved in, org confirmed). Pre-determined AR customers are confirmed ahead of launch. New customers purchasing AR are directed to contact sales, then the same manual process applies. Mid-term: self-serve reconciliation/confirmation flow. Details in [#596355](https://gitlab.com/gitlab-org/gitlab/-/work_items/596355). |
| SM/Dedicated auto-confirmation | MUST | Organizations | Single-organization instances are auto-confirmed. No customer action needed. |
| Confirmation status queryable | MUST | Organizations | The confirmation status MUST be queryable on the Rails side so that the caller can enforce the gate before calling AR's namespace creation API. |
| Confirmation enforced by caller | MUST | Rails | The caller MUST ensure the organization is confirmed before calling AR's namespace creation API. AR trusts the caller and does not check confirmation status itself. |
| Multi-TLG purchase fallback | MUST | Organizations + AR | If an unknown .com customer with multiple TLGs attempts to purchase AR, the UX MUST surface messaging directing them to contact sales for assisted consolidation. |

### ID stability

| Requirement | Level | Owner | Detail |
| ----------------------------------- | ------- | --------------- | -------------------------------------------------------------- |
| Immutable organization ID | MUST | Organizations | The `organizations.id` assigned to an organization MUST NOT change. AR stores this in its anchor tuple and uses it for billing attribution. A change would orphan the namespace. |
| Organization rename has no impact | MUST | AR | Organization names and paths are mutable. AR does not use them. The slug is the stable identifier in all URLs and client configurations. Organization renames MUST NOT require any action from AR. |

### UI placement

| Requirement | Level | Owner | Detail |
| ---------------------------------- | ------- | -------------------- | -------------------------------------------------------------- |
| Organization object in sidebar | MUST | Organizations | AR needs an anchor point in the GitLab UI where the Artifact Registry feature can be surfaced. The current direction is an Organization object in the side panel. |
| AR accessible to non-admin users | MUST | Organizations + AR | Artifact management (browsing repositories and artifacts, pulling/pushing artifacts) is not an admin-only workflow. Non-organization-owners need access to the AR UI under the organization. |
| Settings placement | MUST | Organizations + AR | AR MUST be able to place its settings without waiting for the Organizations team to finalize the UI pattern. Settings can move to their final location later. The Organizations team decides the UI pattern (admin area vs. Organization > Settings); AR decides where to surface its configuration within that pattern. AR settings are stored in AR's own database, not in Rails or under Organization settings. |

### Billing and entitlement

Billing is covered in detail in [#591904](https://gitlab.com/gitlab-org/gitlab/-/work_items/591904). The provisioning pipeline ([design](https://gitlab.com/gitlab-org/customers-gitlab-com/-/merge_requests/15263)) and utilization tracking ([proposal](https://gitlab.com/gitlab-org/customers-gitlab-com/-/merge_requests/15308)) are owned by the Fulfillment team, not the Organizations team. The following items are the billing prerequisites that intersect with Organizations:

| Requirement | Level | Owner | Detail |
| --------------------------------------- | ------- | ----------------------------- | -------------------------------------------------------------- |
| Organization-level entitlement | MUST | Organizations + Fulfillment | AR is sold at the Organization level. The `organization_id` column on `subscription_add_on_purchases` (already exists from Protocells work) is the entitlement anchor. |
| AR is organization-only | MUST | All | AR MUST NOT be sold to customers on the default (unconfirmed) organization. A confirmed organization is a hard prerequisite. The onboarding flow MUST NOT proceed until the provisioning and utilization pipelines are operational. |
| Transfer flow for existing customers | MUST | Organizations | Existing TLG customers who want AR MUST have an Organization before AR can be enabled. The Fulfillment [provisioning migration (Phase 3)](https://gitlab.com/gitlab-org/customers-gitlab-com/-/merge_requests/15263) is blocked on this flow being available. |

### User membership

| Requirement | Level | Owner | Detail |
| ----------------------------------- | ------- | --------------- | -------------------------------------------------------------- |
| Organization membership queryable | MUST | Organizations | Rails must be able to resolve whether a user is a member of a given organization. Authentication and authorization details are out of scope for this agreement. |

Users can be members of multiple organizations (via `organization_users` join table). Each AR request is scoped to a single namespace (and therefore a single organization). A single request cannot span multiple organizations. Public repositories remain accessible without org membership. Non-isolated organizations do not require a user claiming step; user/account migration only applies to the isolated version (future).

## Organization merges

> **Note:** This section goes deeper than the rest of the document because both teams need a shared understanding of the problem space before the requirements can be finalized. Once agreed, the key requirements will be consolidated into [Organization requirements](#organization-requirements), and AR-specific design details will move to a separate document.

Organization merges are not on the immediate roadmap ([Merge Tooling epic](https://gitlab.com/groups/gitlab-org/-/work_items/21394)). Nevertheless, the architecture MUST NOT make merges structurally impossible and MUST facilitate them.

With the current architecture, when two organizations merge, if both have AR enabled, the surviving organization ends up with two namespaces. Two namespaces means duplicated data (billed twice), duplicated configurations, and no unified view of artifacts. One namespace per organization is the only desired *target* state.

For the initial release, preventive gates (e.g., restricting each customer to one AR-enabled organization) and the [merge-blocking requirement](#initial-phase-blocking) (below) are sufficient. In the mid-to-long term, unplanned or organic organization merges are inevitable, have an unpredictable cadence and thus MUST be handled without requiring engineering intervention.

### Merge trigger

When two organizations merge, one survives and one is absorbed. From AR's perspective, the immediate action is an anchor tuple update: the absorbed namespace's `entity_id` is updated to point to the surviving `organization_id`. This is a single row update per namespace. No data moves.

The [Namespace Decoupling ADR](/handbook/engineering/architecture/design-documents/artifact_registry/decisions/022_namespace_decoupling/#organization-merges) makes this possible by scoping all data to the namespace rather than to `organization_id`. Without this indirection (i.e., if AR attached directly to `organization_id`), even this step would require a full data migration.

| Requirement | Level | Owner | Detail |
| --------------------------- | ------- | --------------- | -------------------------------------------------------------- |
| Transfer rule declaration | MUST | AR | AR MUST declare its [organization transfer support](https://docs.gitlab.com/development/database/database_dictionary/#organization-transfer-support) rules. AR's transfer rule: update `entity_id` in the `namespaces` table to the surviving `organization_id`. No other AR tables reference `organization_id` directly. |
| Merge event notification | MUST | Organizations | When the Organizations team implements merges, AR MUST be notified so it can execute the anchor tuple update synchronously. |

#### Merge scenarios

The outcome depends on which organizations have AR enabled:

1. **Only the surviving organization has AR:** Nothing changes. The namespace already points to the surviving organization.
2. **Only the absorbed organization has AR:** The anchor tuple is updated to point to the surviving organization. Because all data is scoped to the namespace (not to `organization_id`), no data migration is needed. Namespace, slug, and all data remain unchanged. 1:1 preserved.
3. **Both organizations have AR:** The surviving organization holds two namespaces. This enters the transitional [namespace consolidation](#namespace-consolidation) state described below.

#### Initial phase: blocking

The namespace consolidation tooling and multi-namespace UX described below do not exist today. Until they are available, organization merges where both organizations have AR enabled MUST be blocked. Allowing the merge without the corresponding UX and tooling would put customers in a state they cannot see, control, or resolve.

| Requirement | Level | Owner | Detail |
| ---------------------------- | ------- | --------------- | -------------------------------------------------------------- |
| Block merge on AR conflict | MUST | Organizations | Organization merges MUST be blocked when both organizations have active AR namespaces, until namespace UX and consolidation tooling are available. |

### Namespace consolidation

The 1:N state SHOULD be *transitional*, not permanent, but since the proposed consolidation is customer-driven, convergence cannot be enforced for as long as that remains the case. 1:1 remains the desired *target* state. Regardless, the 1:N state MUST be *managed*: customers need visibility into both namespaces and migration controls to converge back to 1:1 at their own pace. Refusing to support it would either block organization merges indefinitely or force disruptive, opaque data migrations that neither the customer nor the platform can operate safely at scale.

#### Why this requires data migration

AR partitions data and deduplicates storage by namespace. Any system that scopes data by a boundary must reconcile that data when the boundary changes. If two namespaces become one, the partitioned data and the deduplication context must be consolidated. This is true regardless of what the anchor entity is (organization, top-level group, or any other boundary). The namespace abstraction shields AR from data migration when the organization changes ([scenario 2](#merge-scenarios)). Data migration is only needed when the customer wants to consolidate two namespaces into one ([scenario 3](#merge-scenarios)), and that is driven by the 1:1 target state, not by the merge event itself.

#### Multi-namespace UX

Once available, the UX for multi-namespace MUST provide at minimum:

- **Namespace listing:** All namespaces under the organization, with usage and billing per namespace.
- **Repository browsing per namespace:** Navigate each namespace independently to decide what to move.
- **Migration controls:** Move repositories from one namespace to another.
- **Billing visibility:** Per-namespace storage and usage so the customer understands the cost of keeping two namespaces active.

The following diagrams illustrate the concept only; they do not prescribe the UX. They show how the navigation structure would differ between the two states:

**1:1 (target state):** The organization's single AR namespace exists in the backend but the UX hides it. Repositories are listed directly under the Artifact Registry landing page.

```text
┌─ Organization: Acme Corp ───────────────────────────┐
│                                                     │
│  Artifact Registry                                  │
│  ┌─────────────────────────────────────────────┐    │
│  │ namespace: acme-eng (hidden from UX)        │    │
│  │                                             │    │
│  │  ├── acme-eng/my-app                        │    │
│  │  ├── acme-eng/platform-lib                  │    │
│  │  ├── acme-eng/service-a                     │    │
│  │  └── ...                                    │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

**1:N (post-merge transitional state):** Acme Corp absorbed another organization, bringing in the `acme-platform` AR namespace. It now lives alongside the original `acme-eng` namespace. Namespaces are surfaced as a navigation level. Each has its own repositories, access rules, billing, and migration controls.

```text
┌─ Organization: Acme Corp (merged) ──────────────────┐
│                                                     │
│  Artifact Registry                                  │
│  ┌─────────────────────────────────────────────┐    │
│  │ ▸ acme-eng              3 repos    1.2 GB   │    │
│  │ ▸ acme-platform         2 repos    0.8 GB   │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ▾ acme-eng (expanded)                              │
│  ┌─────────────────────────────────────────────┐    │
│  │  ├── acme-eng/my-app                        │    │
│  │  ├── acme-eng/service-a                     │    │
│  │  └── ...                                    │    │
│  │                                   [Migrate] │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

#### Migration approach

Namespace consolidation MUST be customer-led. An automated big-bang migration MUST NOT be used: each customer's data layout, client configurations, and operational constraints are different. The [.com container registry migration](https://gitlab.com/groups/gitlab-org/-/work_items/5523) demonstrated that large-scale automated online migrations may succeed, but only as a carefully orchestrated, one-time event. Organization merges are a recurring, self-service operation that requires a different approach.

Two mechanisms are under consideration (not mutually exclusive):

- **Customer-driven migration:** The customer moves repositories between namespaces at their own pace using the tooling provided by GitLab.
- **Automatic lazy migration:** Repositories migrate to the surviving namespace transparently on client access.

There MAY be an opportunity to reuse some of the migration functionality AR will provide for importing artifacts from other providers, post-MVP. The internal details of the data migration fall outside this document's scope.

Once the source namespace is empty, it SHOULD be decommissioned and its slug MUST become an alias for the surviving namespace. Both slugs resolve to the same namespace with no redirect. Customers SHOULD be able to *permanently* disable the alias once all clients have migrated to the surviving slug's URLs. For security reasons, the slug MUST remain reserved indefinitely, to prevent stale client configurations from resolving to a different customer's namespace.

### Preventing multi-namespace scenarios

A related but distinct concern is prevention: how to *reduce* the likelihood of customers ending up with multiple AR-enabled organizations in the first place. The order in which customers confirm organizations and enable AR matters:

1. Customer has TLG-A and TLG-B.
2. Each TLG is transferred to its own organization.
3. Customer enables AR on both organizations. Each gets its own namespace.
4. Soon after, the two organizations merge. The surviving organization now has two namespaces.

The [merge trigger](#merge-trigger) and [namespace consolidation](#namespace-consolidation) sections above address what happens when this occurs. The concern here is reducing the likelihood of reaching that state.

Only ~2.7% of .com customers have more than one TLG ([source](https://gitlab.com/gitlab-org/gitlab/-/work_items/591904#note_3185140930)), but this figure likely understates the problem because it averages across all .com customers, while enterprise customers (AR's primary adoption target) tend to have more complex organizational structures with multiple TLGs. SM/Dedicated are not affected (single organization, ID=1). The risk concentrates in .com enterprise customers, where AR adoption matters most.

#### Preventive gates

| Gate | Level | Owner | Detail |
| ----------------------------------------------- | -------- | ---------------------------------- | -------------------------------------------------------------- |
| **Reconciliation before AR** | SHOULD | Organizations | Multi-TLG customers SHOULD be able to consolidate TLGs into a single organization before enabling AR. Self-service reconciliation UI tentatively scheduled for FY27-Q2. A [POC exists](https://www.youtube.com/watch?v=HEfZzK4r9nQ). For launch, consolidation is handled through the confirmation mechanism ([open question](#open-questions)). |
| **Limit AR to one organization per customer** | SHOULD | AR + Organizations + Fulfillment | Product decision to restrict AR enablement to a single organization per billing account. Prevents the problem entirely. May frustrate customers who genuinely need separate organizational boundaries. |
| **Bespoke migration for early adopters** | WILL | Organizations | Multi-TLG early adopter customers will be consolidated into a single organization ahead of AR launch. |

## Open questions

| Question | Owner | Context |
| -------------------------------------------------------------- | -------------------- | -------------------------------------------------------------- |
| When will the self-service reconciliation UI be ready for multi-TLG customers? | Organizations | A [POC exists](https://www.youtube.com/watch?v=HEfZzK4r9nQ). Tentatively scheduled for FY27-Q2. For launch, consolidation is handled through the manual confirmation process. See [Preventive gates](#preventive-gates). |

## Proposed path forward

This section sequences the requirements above into a phased rollout. Each phase builds on the previous one. Each item traces back to a requirement, constraint, or rationale defined in the preceding sections; reading them first is essential.

### Phase 0: pre-launch

**Target:** end of June 2026

The following items must be addressed before AR can onboard customers:

| Item | Owner |
| --- | --- |
| Organizations available on all install types (SM/Dedicated already has org ID=1) | Organizations |
| Organization object in the side panel, providing the UI anchor for AR | Organizations |
| Confirmation status queryable on Rails, so the caller can gate namespace creation | Organizations |
| Organization-level entitlement anchor | Organizations + Fulfillment |
| Organization membership queryable | Organizations |
| TLG-to-unconfirmed-Organization transfer on .com | Organizations |
| Shell landing page created | Organizations |
| Non-admin users can access the organization | Organizations |
| Settings UI pattern decided (admin area vs. Organization > Settings) | Organizations |
| Documentation and onboarding must communicate that two organizations with AR cannot merge until namespace consolidation tooling is available in the future (TBD) | AR + Organizations |
| Decision on whether to limit AR enablement to one organization per billing account, and enforcement gate if yes | AR + Organizations + Fulfillment |
| Multi-TLG early adopter customers consolidated into a single organization before AR enablement | Organizations |

### Phase 1: launch (MVP)

**Target:** end of Q2 FY27 (July 2026)

AR begins customer onboarding on .com. SM and Dedicated onboarding is deferred until the unified self-service onboarding workflow is available (Q3/Q4 FY27):

| Item | Owner |
| --- | --- |
| SM/Dedicated: organization auto-confirmed on purchase without customer action | Organizations |
| .com: organization confirmed and AR namespace created after purchase (mechanism is an [open question](#open-questions)) | Organizations + AR + Fulfillment |
| Organization merges blocked when both organizations have AR; merge blocker surfaces this limitation explicitly | Organizations |

### Phase 2: namespace consolidation

**Target:** TBD

Removes the merge blocker by providing the tooling and UX for converging two AR namespaces into one:

| Item | Owner |
| --- | --- |
| Multi-namespace UX: namespace listing, per-namespace usage, repository browsing, and migration controls | AR |
| Customer-driven migration UX: repositories move between namespaces at the customer's pace | AR |
| Merge event trigger so AR can execute anchor tuple updates | Organizations |
| Decommissioned namespace slug becomes an alias; both slugs resolve to the surviving namespace | AR |
| Lift the Phase 1 merge blocker once multi-namespace UX and consolidation tooling are available | Organizations |

## Related

**AR architecture decisions:**

- [Organizations as Anchor Point ADR](/handbook/engineering/architecture/design-documents/artifact_registry/decisions/001_organizations_as_anchor_point/)
- [Namespace Decoupling ADR](/handbook/engineering/architecture/design-documents/artifact_registry/decisions/022_namespace_decoupling/)

**Organizations architecture decisions:**

- [SM/Dedicated Single Organization ADR](/handbook/engineering/architecture/design-documents/organization/decisions/007_self_managed_dedicated_single_organization/)
- [Organization transfer support (database dictionary)](https://docs.gitlab.com/development/database/database_dictionary/#organization-transfer-support)

**Interface agreements:**

- [AR/Infrastructure](https://docs.google.com/document/d/1GApsHWd3XaQ0Z40Dk7J_pM9sWqDDJlbD9tQuBiebHLI/edit)
- [AR/Auth](https://docs.google.com/document/d/1LeO8pmw8hSt5RBCfk_9ZmIXTkLJD9SOnKnzH3BOYkcE/edit)

**GitLab issues and epics:**

- [Non-Isolated Organizations: User Onboarding & AR Enablement](https://gitlab.com/groups/gitlab-org/-/work_items/21393)
- [Organization and TLG Reconciliation (Merge Tooling)](https://gitlab.com/groups/gitlab-org/-/work_items/21394)
- [CustomersDot: Service Onboarding and Slug Registration](https://gitlab.com/gitlab-org/gitlab/-/work_items/594637)
- [Licensing, Billing, and Provisioning](https://gitlab.com/gitlab-org/gitlab/-/work_items/591904)
- [Slug Validation Rules and Reservation Policy](https://gitlab.com/gitlab-org/gitlab/-/work_items/593368)
- [User-facing Name for Namespace Entity](https://gitlab.com/gitlab-org/gitlab/-/work_items/593366)

**Key comments:**

- [Q2 descoped onboarding summary](https://gitlab.com/groups/gitlab-org/-/work_items/21393#note_3218405112) (2026-04-02)
- [TLGs vs Organizations clarification](https://gitlab.com/groups/gitlab-org/-/work_items/21393#note_3215000014) (2026-04-01)

**Other references:**

- [Organizations: MVP Launch Requirements meeting notes](https://docs.google.com/document/d/1MGC_YTYPD1qfs7k-aYcACTJzAFJQdFr-MTATU1cfZVA/edit) (2026-04-08)
- [CTO Module Review](https://docs.google.com/document/d/1xZ4B1iW4srffOViwHYFqVumnlUuBcp7ivN_Jk_UKj9c/edit)
- [CTO Review Notes](https://docs.google.com/document/d/1qkcOZYSHM_h9k9pYjHze2KHG5qZYMDeZ1UE4GZgD1jw/edit)
- [Onboarding and merging POC demo](https://www.youtube.com/watch?v=3n_kWMND6B4)
- [Reconciliation POC demo](https://www.youtube.com/watch?v=HEfZzK4r9nQ)
- [Organization sidebar POC demo](https://www.youtube.com/watch?v=beLvhq2yKJQ)
- [Organization Landing Page UX alignment notes](https://docs.google.com/document/d/1VxGKnpGjh_Q7P9qwlQIlRPzEkG94bjv-dfLkFex2SaI/edit?tab=t.0#heading=h.c5sl9vcfa76q)
- [Organization Landing Page and AR design (Figma)](https://www.figma.com/design/RXKqp5o48qTtLzuWLLukUR/Org-%3C%3E-AR-GA?node-id=169-10261)
- [Org/AR user flow design (Figma)](https://www.figma.com/board/4uenKEJdAdT2g7e5ROy91i/Org-%3C%3E-AR-user-flow?node-id=0-1)
