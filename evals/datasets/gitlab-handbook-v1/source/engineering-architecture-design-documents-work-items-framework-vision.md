---
slug: engineering-architecture-design-documents-work-items-framework-vision
title: "Work Item Framework Engineering Vision"
source_url: "https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/work_items_framework_vision/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: "Work Item Framework Engineering Vision"
status: proposed
creation-date: "2026-02-13"
authors: [ "@msaleiko" ]
coaches: ["ntepluhina", "@engwan"]
dris: [ "@acroitor", "@gweaver" ]
owning-stage: "~devops::plan"
participating-stages: []
toc_hide: true
---

{{< engineering/design-document-header >}}

## Summary

This document serves as an engineering vision and decision-making framework for the Work Item Framework.
It establishes architectural principles and technical direction for the next 2-3 years to guide teams building enterprise agile planning capabilities in GitLab.

The vision is intentionally high-level to allow flexibility in implementation details while providing clear
boundaries on what we should and should not do to ensure our platform remains scalable, extensible, and flexible.

## Motivation

To build the future of enterprise agile planning at GitLab and implement the [Plan stage's strategic UX vision (internal link)](https://gitlab.com/gitlab-org/plan-stage/product-design/-/wikis/Plan-Strategic-UX-Vision/),
we need a flexible system on both backend and frontend that scales the work item framework beyond its current state.

Multiple teams work on the work item framework with varying levels of interaction. This vision functions as a blueprint that teams members can use
to check every decision they make along the way of implementing a feature. It helps ensure consistency across teams and prevents architectural drift.

## North Star: Unified Work Item Framework for Planning and Collaboration

Work items track work as it flows through the SDLC and enable collaboration across teams. The framework unifies all planning and collaboration concepts that share a common purpose: describing, tracking, and flowing work through defined states. The framework is built once, for all types. Capabilities scale across all work item types without requiring type-specific code.

This scope excludes concepts with fundamentally different purposes that don't fit the collaborative work-tracking paradigm.

Every architectural decision in this document must work towards this vision.

## Related documents

- [Work Items Design Document](../work_items/_index.md) - Current implementation and architecture
- [Configurable Work Item Types](../configurable_work_item_types/_index.md) - Configuration-based approach for types
- [Work Items Custom Status](../work_items_custom_status/_index.md) - FixedItemsModel pattern and system-defined entities
- [Work Items REST API Design Document](../work_item_rest_api/_index.md)
- [Fields vs. widgets investigation](https://gitlab.com/gitlab-org/gitlab/-/issues/582173)
- [Plan: strategic UX vision (internal link)](https://gitlab.com/gitlab-org/plan-stage/product-design/-/wikis/Plan-Strategic-UX-Vision/)
- [Plan UX Vision Concepts (internal link)](https://www.figma.com/slides/RszQADhSrckltNpEZQp9w5/Plan-UX-Vision-Concepts?node-id=369-214114&t=aFCRoKAmf18tFY91-0)
- [Work Items Custom Fields Design Document](../work_items_custom_fields/_index.md)
- [Epic To Work Items Migration Design Document](../epic_to_work_item_migration/_index.md)

## Core principles

### 0. Framework Alignment is Non-Negotiable

Every feature, fix, and addition must be framework-aligned. There are no excuses for quick fixes that work only for specific types or require hardcoded checks.

**What this means:**

- A feature built for issues must work for tickets, epics, tasks, and any future type
- The framework must be type-agnostic — it doesn't matter what types exist or which are available
- Configuration and data-driven design are requirements, not nice-to-haves
- Quick fixes that violate this principle delay the vision; doing it right accelerates it

**Why this matters:**

- Every framework-aligned feature automatically works for all types
- Type-agnostic design means organizations can configure their own work item types without code changes
- Future setups might not include issues at all—the framework must work regardless
- This is how we scale without fragmentation

**When to delay:**

If a feature can't be built framework-aligned, it should be delayed until it can be. See [When to delay a release](#when-to-delay-a-release) for details.

**Exception:**

Some types may have domain-specific functionality (see [Special type handling](#special-type-handling)). The exception is for specialized features, not core framework functionality.

### 1. Configuration over type checks

We use a configuration-based approach, on both Backend and Frontend, to control type behavior instead of hard-coded type checks throughout the application. Backend and Frontend must use these configurations, instead of type checks, to ensure how a given type behave.

**What this means:**

- Multiple types can share the same configuration
- Configurations are boolean flags or value-based attributes that control how types behave and render
- We care about "what a type can do" instead of "what a type is"

**Why this matters:**

- Keeps the framework modular, composable, extensible, scalable, and flexible
- Reduces coupling between features and specific types
- Makes it easier to introduce new types without modifying existing code
- Enables custom types to leverage the same capabilities as system-defined types
- Allow for a simpler consumption of work items on the client that result in less impossible UI states and general regression

**Examples:**

```ruby
# Backend: Checking configurations
type.configured_for?(:use_legacy_view)
type.configured_for?(:group_level)
type.configured_for?(:filterable) # for example available in general work item list and filters

# Future: value-based configurations
type.configuration(:required_widgets)
```

**Frontend configuration provider pattern:**

To implement this requirement, the frontend uses a configuration provider pattern that fetches work item type configuration per namespace and caches it in Apollo. This approach is a temporary bridge between our current state (where types have different behaviors) and our vision (where all types behave the same). The provider ensures configuration is always available and up-to-date as users navigate between items in different namespaces. See the [Configurable Work Item Types](../configurable_work_item_types/_index.md) document and its [Frontend metadata provider pattern](../configurable_work_item_types/_index.md#frontend-metadata-provider-pattern) section for implementation details.

**Strongly avoid** inferring behaviors based on available data, and instead make sure to directly match features with the capabilities provided by the API configuration.

### 2. Data-driven frontend architecture

The frontend should be completely data-driven, relying on API responses to determine what to display and how to behave.

**What this means:**

- Filters are fueled by data from API responses (workItemTypes queries, metadata endpoints)
- Fields to show in lists are fueled by API responses
- Fields for bulk edit are fueled by API responses
- No hard-coded assumptions about what fields or widgets are available
- Do not infer any capabilities. For example, if only group work item have a certain behavior, do not do `if(!isGroup)`. Instead, schedule work to have a new API field and consume it in the metadata provider so that all types can benefit flexibly.
- Licensed features checks for fields and features are performed on the backend, so the frontend can rely solely on the API response for displaying available features
- Work items update in real time for all connected clients. If a user changes a field, every other user viewing that item sees the change without refreshing. This applies to the detail view first and expands to everywhere a work item is displayed — lists, boards, and any other aggregation view. All widgets must participate; partial real-time coverage (where some widgets update live and others don't) creates inconsistent behavior and cognitive overhead for users.

**Why this matters:**

- Essential for easily extending the framework
- Supports complex custom fields that feel equal to GitLab-provided fields (widgets)
- Enables different views (table, list) where frontend only cares about visualizing available data
- Reduces frontend changes when backend capabilities evolve
- Real-time updates across all connected clients prevent data drift and conflicting state, which is especially important in collaborative planning workflows where multiple people work on the same items simultaneously

**Open questions:**

1. Check feasibility for all interactions and optimistic updates with data-driven approach.

### 3. System thinking over isolated features

Because we work on a shared platform, we must share what we work on frequently with others to prevent isolated thinking and building silos.

**What this means:**

- Always think in systems instead of isolated components and features
- Abstract solutions to work for the whole framework
- Use configuration wherever it makes sense
- Consider impact on all work item types, not just the one you're implementing for

**Why this matters:**

- Prevents fragmentation and inconsistency
- Reduces technical debt from one-off solutions
- Makes the platform more maintainable long-term
- Ensures features work cohesively across the framework

**Team practices:**

- Share work frequently with other teams
- Review changes with framework-wide impact in mind
- Discourage solutions that only work for specific types
- Develop common understanding that we only do things the right way to protect scalable architecture, even if that means delaying a release

### 4. Make it simple to do the right thing

It should be hard to add code in a way that harms the principles of this engineering vision.

**What this means:**

- Reviewers should discourage code that violates these principles
- Architecture should guide developers toward correct patterns
- Common tasks should have clear, documented approaches
- Anti-patterns should be difficult to implement
- Tests should flag "incorrect" implementations

**Why this matters:**

- Protects architectural integrity
- Reduces cognitive load for new contributors and makes contributing easier
- Prevents gradual degradation of code quality
- Makes reviews more objective and consistent

## API strategy and evolution

### GraphQL API improvements

#### Flatten widgets in work items query

Widgets are exposed as separate fields at the top level of work item queries rather than nested in an array. Each widget field is typed so it returns `null` when not available, eliminating the need for inline fragments and reducing frontend complexity.

**Benefits:**

- Reduces frontend complexity when accessing widget data
- Makes GraphQL API easier to use for customers
- Simplifies data access patterns

**Related work:**

- [Spike: Flatten Work Items object structure](https://gitlab.com/gitlab-org/gitlab/-/issues/493472)
- [MR: Expose work item widgets as separate fields](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/214524)
- [Epic: Consume WorkItem.features hash instead of WorkItem.widgets array](https://gitlab.com/groups/gitlab-org/-/work_items/20609)

### REST API strategy

GraphQL is currently our primary API as our frontend is built on it. However, we're actively investing in a first-class REST API to support third-party integrations, automations, and customers who prefer REST conventions.

See [WorkItem REST API Implementation](https://gitlab.com/groups/gitlab-org/-/work_items/20907) for the concrete implementation epic and [Work Item REST API design document](../work_item_rest_api/_index.md) for detailed technical approach.

**Long-term strategy:**

We need to determine whether REST could become primary in the future if frontend refactoring is justified by performance gains. This decision should be revisited as both APIs mature.

**Related resources:**

- [Work Items REST API Design Document](../work_item_rest_api/_index.md)

**Related epic:**

[Work items - REST API (GA)](https://gitlab.com/groups/gitlab-org/-/work_items/9673) - Overall REST API initiative

### Deprecation strategy for legacy endpoints

Provide clear migration path for customers moving from issue-specific endpoints to work item endpoints.

**Approach:**

- Deprecate issue and epic endpoints with clear timeline
- Potentially work towards deprecating whole `v4` version of REST API
- Deprecate GraphQL issue-specific endpoints
- Clearly state we won't add new functionality to legacy endpoints, but here's how you can migrate and it's easy

**Migration support:**

- Painless migration path is crucial for good customer experience
- Use guides, documentation, and videos
- Provide migration tools and examples

**Terminology transition:**

- Introduce work item terminology throughout (webhooks, integrations, etc.)
- Make it clear that everything issue-related is now work item-related and it exposes items of more types than just "issue"

## Performance and caching strategy

### Backend endpoint caching

Cache high-traffic and expensive queries to improve performance.

**Caching strategies to consider:**

1. **Full response caching** - Only works for queries where data changes infrequently and without post-processing
2. **Partial response caching** - Cache a resolver by serializing it in Rails cache (related to field caching, but might include sub-fields)
3. **Field-based caching** - Using Rails cache or different strategy

**Caching storage strategies:**

1. **Redis (default)** - Using Rails cache and RequestStore
2. **Pod-local memory cache** - Cache duplication intentional to prevent Redis traffic spikes
3. **Pod-local file-based cache** - Still very fast and we don't need to care about memory consumption
4. **Database storage** - Store cache content in database
5. **Object storage cache** - Slowest, but good for permanent caches

**Queries to prioritize for caching:**

Ideally those that block rendering:

- Work item types (by namespace)
- Metadata (by namespace)
- Work items slim (by namespace)
- Work item details
- Notes (ideally, maybe only first pages but hard to achieve because we need post-processing per user)

**Use cases:**

- Works great for almost static data
- For dynamic data scoped to namespaces, could restrict caching to licensed namespaces only for SaaS or `EE`

**Action needed:**

1. TODO: Figure out caching strategy and infrastructure constraints

### Frontend permanent caching

Investigate more persistent caching strategies for endpoints that don't change often or for items the
user accessed multiple times. Extend persistent caching to work item detail and potentially notes queries.

## Data model evolution

### Remove Issue model

The dual-class architecture where WorkItem inherits from Issue creates a constant tax on development. Engineers must reason about whether something is an Issue or a WorkItem, decide which model to put new functionality on, and handle cases where behavior is needed on both the legacy Issue endpoints and the new WorkItem surface. This slows down day-to-day development, introduces subtle bugs when the two classes diverge, and makes onboarding harder.

**Current problem:**

- Inheritance chain: base → issuables → issues → work items → 2x for CE and EE
- Creates "inheritance hell" for services
- Adds complexity and maintenance burden
- Logic conceptually belonging to WorkItem keeps getting added to Issue because legacy API still instantiates Issue directly

**Approach:**

Make WorkItem the single authoritative model backed by the issues table, with Issue reduced to a constant alias for backward compatibility. This eliminates the ambiguity entirely: there is one model, it is called WorkItem, and the Issue constant exists only as a backward-compatible alias until all references are migrated.

**Related decisions:**

- Revisit `Issuables` approach. Currently a concern shared between Issue and MergeRequest providing common interface for title/description, state, labels, milestones, assignees, notes, and sorting. After Issue removal, consider whether `Issuable` becomes a "work item light" pattern — a lighter version of the work item framework that provides out-of-the-box list and detail views, create and update services, and common concerns (subscriptions, comments, descriptions, reactions, mentions) that could serve a broader internal audience beyond just planning.

**Related work:**

- [Epic: Fully migrate Issue model to WorkItem](https://gitlab.com/groups/gitlab-org/-/work_items/21228)
- [Knowledge base: Remove issue model](https://gitlab.com/gitlab-org/gitlab/-/work_items/592449) - Detailed research, migration approaches, and execution plan

### Fields and features

The relationship between fields, widgets, and custom fields needs clarification and alignment.

**Current state:**

Custom fields are nested inside a dedicated widget (the custom fields widget). In the GraphQL API, they appear under `features.customFields` rather than as top-level fields. On the frontend, custom fields are visually presented at the same hierarchical level as other fields, but architecturally they are nested within a widget.

**Key questions:**

- Should custom fields remain nested within a widget, or should they be elevated to top-level fields like other work item fields?
- If custom fields should feel equal to GitLab-provided fields on the frontend, should the backend also treat them equally, or is the current separation (backend nesting, frontend flattening) the right approach?
- How does this distinction affect the data-driven frontend architecture and API design?

**Related investigation:**

- [Fields vs. widgets investigation](https://gitlab.com/gitlab-org/gitlab/-/issues/582173)

## Frontend architecture details

### Notes rendering optimization

Notes need to load fast, especially the newest comments since users are more likely interested in newer comments than older.

**Approaches to investigate:**

1. **Fetch and render newest first** - Likely won't happen based on UX feedback
2. **Only fetch newest X records** - Display message about limitation with action to load everything. Doesn't solve layout jumps because we still render old to new. Potentially hard to calculate because we need to include new replies to old discussions.
3. **Load newest X pages first** - Then either:
   - Load all older pages, or
   - Stop and show message with button to load everything (might drop new comments on old discussions)

**Open questions:**

1. TODO: How do we handle deep links for items that aren't loaded yet and would only be loaded after selecting the "load all" button?

## Special type handling

Service Desk and Incident Management functionality is tied to specific work item types (`ticket` and `incident`).

**Approach:**

Use configuration flags and type providers rather than hard-coded type checks.

**Configuration flags for quick checks:**

```ruby
type.configured_for?(:service_desk)         # Is this the service desk type?
type.configured_for?(:incident_management)  # Is this the incident type?
```

**Type provider for lookups:**

```ruby
# Finding the designated type for a feature
WorkItems::TypesFramework::Provider.new(namespace).service_desk_type
WorkItems::TypesFramework::Provider.new(namespace).incident_type
```

**Required widgets:**

Types like `ticket` and `incident` have mandatory widgets needed for their associated features. These required widgets are:

- Defined as part of the system-defined type definition
- Inherited by converted custom types via `converted_from_system_defined_type_identifier`

**Related work:**

- [Configurable Work Item Types](../configurable_work_item_types/_index.md) defines this approach

## Licensing and downgrade strategy

When designing features for the work item framework, we must always consider tiering and downgrade paths from the start.

**Core principle:**

Keep existing configurations and data intact on downgrade, but disallow mutations. Simply hide licensed functionality rather than destroying or converting data.

**What this means:**

- **On reads:** Continue to use already-configured features and data as-is
- **On writes:** Block creating new configurations and modifying existing ones that require a higher tier
- **For widgets:** If a widget is licensed, hide it on downgrade rather than removing the underlying data
- **For relationships:** Keep existing relationships intact but prevent new ones that violate tier limits

**Why this matters:**

- Avoids destructive actions and perceived data loss
- Simplifies re-upgrade scenarios (no need to restore or migrate data)
- Provides clear, expected behavior for customers
- Reduces complexity in downgrade/upgrade logic

**Related work:**

- [License downgrades for custom work item types](https://gitlab.com/gitlab-org/gitlab/-/issues/579231) - Detailed downgrade strategy for configurable work item types
- [Work Items Custom Status](../work_items_custom_status/_index.md) - Existing pattern for status downgrades

## Decision-making framework

Use this framework when making architectural decisions:

### Questions to ask

1. **Does this solution work for all work item types, or just one?**
   - If just one, can it be generalized?
   - Should it be configuration-based instead?

2. **Does this require type checks, or can it use configuration?**
   - Prefer configuration over type checks
   - Think "what can this type do" not "what is this type"

3. **Is the frontend data-driven, or does it have hard-coded assumptions?**
   - Prefer metadata-driven over hard-coded
   - Can this be determined from API responses?
   - Work with backend counterparts to expose necessary fields and use `@gl-introduced` directive

4. **Does this create isolated functionality, or does it fit the system?**
   - Prefer system-level solutions
   - Can this be abstracted for reuse? Remember this is a framework!

5. **Will this make it simple for others to do the right thing?**
   - Is the pattern clear and documented?
   - Does it guide toward correct usage?

### When to delay a release

We should discuss delaying a release when:

- The implementation violates core principles
- A quick fix would create significant technical debt
- The solution only works for one type when it should work for all
- Hard-coded type checks are used instead of configuration

It's better to delay and do it right than to ship something that harms the framework's scalability.

#### Shortcuts and technical debt

Shortcuts are scaffolding, not permanent solutions. We may need them to meet hard deadlines, but we must understand the trade-off: every shortcut delays the entire framework track. Shortcuts should be the exception, not the rule. Always clean them up before release—they're temporary supports for building, not part of the final structure.

## Open investigations and decisions needed

This section tracks major technical decisions that need investigation and resolution.

### High priority

1. **REST vs. GraphQL strategy** - Which should be primary? Performance implications?
2. **Caching infrastructure** - Which strategies to use? Infrastructure constraints?
3. **Issuables future** - Separate from work items or unified?
4. **Fields vs. widgets** - How do these concepts relate? See [investigation issue](https://gitlab.com/gitlab-org/gitlab/-/issues/582173)

### Medium priority

1. **Notes rendering** - Which optimization approach to implement?
2. **Deep linking** - How to handle deep links to not-yet-loaded content?

## Success criteria

We'll know this vision is successful when:

1. **Teams make consistent decisions** - Different teams arrive at similar solutions for similar problems
2. **Type checks decrease** - Configuration-based approach becomes the norm
3. **Frontend is truly data-driven** - No hard-coded assumptions about available fields
4. **New types are easy to add** - Adding a new type doesn't require changes throughout the codebase
5. **Performance improves** - Performance optimizations and caching strategies are in place and effective
6. **Customer migration is smooth** - Clear path from legacy endpoints to work items

## Team collaboration

### Communication expectations

- Share significant work early and often
- Tag relevant teams on MRs with framework-wide impact
- Discuss architectural decisions before implementation
- Use this document as reference in design discussions
- Contribute to this design document

### Review standards

Reviewers should:

- Check alignment with this vision
- Question type checks (should it be configuration?)
- Verify data-driven frontend approach
- Ensure solutions work system-wide, not just for one type

### Teams involved

When making changes to this document feel free to include the entire stage or start with a subset and expand later on.

```text
@gitlab-org/plan-stage/project-management-group/engineers @gitlab-org/plan-stage/product-planning-group/engineers @johnhope @gweaver @nickleonard
```
