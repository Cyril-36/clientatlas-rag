---
slug: engineering-architecture-design-documents-gitlab-cd-cd-execution
title: "GitLab CD: Deployment Execution"
source_url: "https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/gitlab_cd/cd_execution/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
title: "GitLab CD: Deployment Execution"
status: proposed
creation-date: "2026-03-25"
authors: [ "@josephburnett" ]
coach: []
approvers: []
owning-stage: "~devops::deploy"
participating-stages: []
toc_hide: true
---

{{< engineering/design-document-header >}}

This document describes the Beta deployment-execution path for GitLab CD using Argo Rollouts. It covers onboarding (Environment connection, application-environment setup, manifest validation), coordinated multi-service deployment (SHA pinning, parameter overrides, canary progression), and rollback to any prior VersionSet.

This is the Deployment Execution team's doc — the execution layer. The Rails domain model is described in GitLab CD: Rails. This document does not restate it. It references the domain entities the deployment flow needs (`VersionSet`, `Environment`, `Rollout`, `Deployment`) and otherwise stays focused on what runs against the cluster.

Argo CD Core and Argo Rollouts are **prerequisites**. The cluster operator installs them. GitLab CD connects to a running cluster through the GitLab Agent for Kubernetes (`agentk`) — it does not install or manage controllers. This is a deliberate scope boundary: we onboard Environments, we don't provision them.

Argo Rollouts is a Kubernetes controller for progressive delivery. GitLab owns the rollout strategy. Argo Rollouts owns the `ReplicaSet` mechanics. Argo CD Core is the GitOps reconciler. It syncs Git state to the cluster. GitLab CD pins Argo CD to a specific commit SHA and controls when it advances. The reconciler never auto-syncs.

Deployment actuation runs through a **Deploy Driver**. A Deploy Driver is not a binary loaded into KAS. It is declarative data shipped as a Ruby gem: a manifest, a set of `Starlark` workflows, and two config schemas. The manifest is the entry point — it names the driver, declares which pipeline steps the driver can enact, and points at the workflow and schema files. For the Beta there is exactly one driver — an Argo Rollouts driver — built by the Deployment Execution team and imported by the monolith. Details below.

Everything that touches the cluster — onboarding, deployment, observation — runs as an AutoFlow workflow. Rails owns the domain model. AutoFlow owns execution. Events connect them.

This is a sub-document of the [GitLab CD System](../gitlab_cd/) design. It assumes familiarity with the [Application Entity PRD](https://gitlab.com/groups/gitlab-org/-/work_items/21247), the [AutoFlow engine](https://gitlab.com/groups/gitlab-org/-/work_items/21235), and the [GitLab Events Platform](https://gitlab.com/gitlab-com/content-sites/handbook/-/merge_requests/18106).

## The problem

GitLab CD needs to deploy to Kubernetes with progressive rollout, health observation, and human-in-the-loop approval — without owning the workload definition and without requiring GitLab CI or GitLab source control.

The deployment target is an Argo `Rollout` CR in a Kubernetes cluster. The workload definition lives in a Git repository. For the Beta the repo is GitLab-hosted. External forges (GitHub, Bitbucket) are a goal — most expose an API for reading and committing files, so we rarely need a `git` binary, but some Functions will need a Runner-style execution environment when we do. Argo CD Core reconciles Git state to cluster state. The GitLab Agent for Kubernetes (`agentk`) provides the cluster connection and event observation. AutoFlow orchestrates the workflows.

The workload definition — container arguments, resource limits, the manifests themselves — is external and opaque to GitLab CD. It lives in the user's Git repo, behind the driver. Rails never models it.

## Architecture

### Organizing principle

GitLab CD decides *what version* runs *where* and *how it rolls out*. The reconciler is a dumb applier pinned to a specific commit. The user owns their repo, their Git workflow, their manifest structure. GitLab CD owns the deployment lifecycle.

### Execution-relevant domain entities

The full domain model lives in GitLab CD: Rails. The deployment flow needs four of its concepts:

- **VersionSet** — an immutable set of `(Version, Service)` pairs. A Rollout promotes one VersionSet. It does not change as the Rollout progresses.
- **Environment** — a named deployment target (development, staging, production). Rails stores a versioned driver binding against it: `driver_ref` plus an opaque `driver_config` blob (the Environment config — for the Argo driver, a cluster agent id).
- **Rollout** — promotes one VersionSet across one or more Environments (staging then production then ...) under a single AutoFlow workflow, moving from environment to environment until done. The Rollout pins its VersionSet, its pipeline (flow definition) version, and its driver binding at creation. All of it is immutable.
- **Deployment** — the per-`(service, environment)` actuation. State driven by domain events.

Rollback is a new Rollout, not a state on an existing one. A user creates a new Rollout targeting a prior VersionSet. The old Rollout records never mutate.

### Event paths

There are three distinct event paths. They don't cross.

**Registry events** flow through the Events Platform into Sidekiq workers. These create Versions and VersionSets in the CD tables. AutoFlow is not involved.

**Cluster events** (Argo `Rollout` status changes, Argo CD `Application` sync status) flow from `agentk` into AutoFlow. The driver's `Starlark` calls `k8s.watch` (push) or `k8s.get` (poll); the function reaches the object through `agentk`. AutoFlow is the sole consumer. No other system interprets raw cluster state. We can route these through the Events Platform later if other consumers need them.

**CD domain events** flow from AutoFlow through the Events Platform into Sidekiq workers. These update state in the CD tables, drive the dashboard, and feed the audit log. They are implementation-agnostic — they describe what's happening in CD terms, not Kubernetes terms.

Note: events are ephemeral transport. The CD Rails tables are the system of record. CD never replays the events platform for history — domain events update the tables and the tables hold the truth.

```text
Registry events:
  Artifact Registry -> webhook/poll -> Events Platform -> Sidekiq -> CD tables
  (Version, VersionSet creation. No AutoFlow.)

Cluster events:
  agentk -> k8s.watch / k8s.get (CD Function) -> AutoFlow (sole consumer)
  (Argo Rollout phase changes. The driver Starlark subscribes or polls.)

CD domain events:
  AutoFlow -> Events Platform -> Sidekiq -> CD tables
  (rollout.started, deployment.started, gate_reached, healthy, etc.)
  (Same path as registry events. Implementation-agnostic.)
```

### Rails to AutoFlow interface

Rails talks to AutoFlow through a `StartWorkflow` gRPC endpoint on KAS. This is an imperative interface: "here's a workflow, run it."

```protobuf
service AutoFlow {
  // Reactive: match event to handlers in a flow project.
  rpc CloudEvent(CloudEventRequest) returns (CloudEventResponse);

  // Imperative: run a workflow.
  rpc StartWorkflow(StartWorkflowRequest) returns (StartWorkflowResponse);
}

message StartWorkflowRequest {
  string workflow_id = 1;           // caller-chosen, for idempotency
  bytes starlark = 2;               // the driver's deployment workflow
  map<string, string> secrets = 3;  // Git credentials, registry tokens — resolved live by reference
}

message StartWorkflowResponse {
  string workflow_id = 1;           // confirmed, stored
}
```

The existing `CloudEvent` RPC is reactive — it sends an event and AutoFlow matches it to handlers defined in a flow project. `StartWorkflow` is different. Rails submits the driver's `Starlark` directly. AutoFlow just runs it.

The call is synchronous but fast — it returns once the workflow is persisted, not once it's done. This is the transactional contract: once you get a 200, you know the workflow will be handled one way or another, asynchronously. Rails stores the `workflow_id` on the entity that triggered it (Environment, Rollout). Domain events flow back through the Events Platform as the workflow executes.

The `workflow_id` is caller-chosen for idempotence. If KAS crashes between persisting and responding, Rails retries with the same ID.

### The `Starlark` is an interpreter, not a compiler target

There is no generic YAML/JSON-to-`Starlark` compiler for the Beta. We don't translate intent into a target-specific program at create time.

Instead, the driver ships one hand-written, target-specific `Starlark` workflow. It *interprets* its inputs at runtime — the VersionSet, the Environment config, the Application-Environment config, and the pipeline config. The same `Starlark` runs for every Rollout that uses the Argo driver. It reads the configurations and acts. There is no per-Rollout code generation.

This keeps the moving parts honest. A different deployment mechanism is a different driver with its own hand-written `Starlark` and its own config schemas — not a new compiler backend. Generic compilation is a possible future, not the Beta.

### Event idempotence

All activities must be idempotent. The workflow guarantee is at-least-once, always.

If an activity emits an event, Rails processes it, but AutoFlow crashes before recording the activity result, the event re-emits on replay. Rails must also be idempotent. Events achieve idempotence through specificity: `gate_reached` carries `deployment_id + weight`, so "Deployment X reached the 25% gate" processed twice is a no-op. The event content itself is the idempotence key. No separate deduplication infrastructure is needed.

Note: `emit` must be an activity (called through `run`), not a bare function call. Otherwise replay would re-emit events. The activity cache makes it idempotent. We say "go past gate N," never "go to the next gate" — the specific target is what makes replay safe.

## The Deploy Driver

A Deploy Driver is declarative data shipped as a Ruby gem. The manifest is the entry point:

```json
{
  "ref": "argo-rollouts",
  "supported_pipeline_steps": ["deploy", "pause", "approval", "analysis"],
  "environment_schema": "environment.json",
  "application_environment_schema": "application_environment.json",
  "workflows": {
    "onboarding": "onboarding.star",
    "application_environment_setup": "app_env_setup.star",
    "deploy": "deploy.star"
  }
}
```

It carries:

1. A **manifest.** It names the driver, declares the pipeline steps the driver can enact (`supported_pipeline_steps`), and points at the workflow and schema files. Rails validates that a pipeline's steps are a subset of `supported_pipeline_steps` when the pipeline is authored, so a mismatch fails at authoring time instead of mid-deploy.
2. A set of **`Starlark` workflows.** Onboarding, application-environment setup, and deployment are separate workflows. They run on AutoFlow, read the configurations and the VersionSet, and actuate against the cluster by calling the built-in CD Functions.
3. An **Environment config schema.** What the driver needs to reach an environment — the environment-level connection. For the Argo driver, a cluster agent id. The UI collects this once per Environment. Rails stores it as the opaque `driver_config` on the Environment's driver binding.
4. An **Application-Environment config schema.** What it means to deploy a given application to a given environment. For the Argo driver, the rollout strategy and whether load balancing is on plus which kind. The UI collects this per `(application, environment)` pair — an application may deploy to multiple environments, with different config in each.

For the Beta there is exactly one driver — an Argo Rollouts driver — built by the Deployment Execution team and imported by the monolith. Rails reads the manifest and schemas to render the config UI by reflection, validates user input against them, and submits the workflows to AutoFlow. The gem stays strictly separate from the CD Rails models. Rails never reaches into driver internals, and the driver never reaches into the domain model.

### The built-in CD Functions

The driver's `Starlark` calls a small set of built-in CD Functions. These replace the old `cd.deploy.*` built-in Functions — there is no generic deploy interface and no go-plugin. For the Beta the Functions are Go, imported directly into GitLab Relay and run in-process. They are not gRPC, and there are no OCI or remote Functions yet — those are deferred. (See agent#883 and epic [&22116](https://gitlab.com/groups/gitlab-org/-/work_items/22116).)

| Function | Purpose |
|---|---|
| `git.read_file` | Read a file from a Git repo at a ref — for example the Argo `Rollout` or `Application` manifest. |
| `git.commit` | Commit file changes to a Git repo (update the GitOps repo to desired state). Returns the new SHA. |
| `argo.sync` | Tell an Argo CD `Application` to sync to a specific SHA. Auto-sync is off; CD advances state SHA to SHA. |
| `argo.promote` | Advance an Argo `Rollout` past a pause/stop point. MUST be idempotent — stop points are identifiable so replay doesn't double-advance. |
| `k8s.get` | Fetch a Kubernetes object through `agentk`. The Beta uses a ~30s polling loop here. |
| `k8s.watch` | Push-based subscription to Kubernetes object events through `agentk`. Deferred behind `k8s.get` polling for the Beta. |

`emit` rounds out the set — it publishes a CD domain event to the Events Platform. It is called through `run` for replay idempotence.

### How the driver actuates a deployment

GitOps state advances SHA to SHA. The driver reads the current manifest with `git.read_file`, computes the desired state (pin image versions from the VersionSet, generate the `spec.strategy` from the Application-Environment config), commits it with `git.commit`, and tells Argo CD to sync to the new SHA with `argo.sync`. From there it observes the Argo `Rollout` CR and advances past each pause point with `argo.promote`.

Note: `argo.promote` must be idempotent. Stop points are identifiable, so a replay that re-runs the promote against an already-advanced rollout is a no-op. This is the canary mechanism — the controller pauses indefinitely at each step and only advances when the driver promotes it past that specific stop point.

### Tradeoff: parameter overrides versus pure GitOps

The Argo driver can set image versions through Argo CD parameter overrides instead of committing them. These render at sync time — they work with Helm, Kustomize, and plain YAML. The driver doesn't need to understand the user's repo structure.

The tradeoff: parameter overrides aren't stored in Git, so the source repo doesn't reflect exactly what's deployed. Argo CD's own docs note this is considered an anti-pattern for pure GitOps. GitLab CD's tables snapshot the SHA and variable values (except secrets) for every Deployment, providing a complete point-in-time audit record. The committed-state path (`git.commit` then `argo.sync`) is the GitOps-pure alternative — same driver, the Application-Environment config picks which.

### Future extension: owned branch model

SHA pinning is the foundation for a future "owned branch" model where GitLab CD maintains its own deploy branch, merges from the user's source branch on its own schedule, and pins the reconciler to SHAs on that branch. The driver Functions don't change — `git.commit` and `argo.sync` just operate on a different branch.

## The interface between Rails and Deployment Execution

The interface is a set of schemas, not a binary API. Three schemas define the contract:

- The **pipeline config schema** (described below).
- The **Environment config schema**.
- The **Application-Environment config schema**.

The two driver config schemas are JSON Schema with UI annotations. A `gitlabUi` keyword carries `widget`, `label`, `description`, and `enumLabels`. Widgets include an agent picker, text/number/checkbox/select, and conditional fields through JSON Schema `if`/`then`. Rails renders the config UI by reflecting over these schemas and validates user input against them. It does not understand the meaning of the fields.

The Deployment Execution team defines all three schemas. The Rails doc owns the full annotation vocabulary — see GitLab CD: Rails. Here it's enough to state the contract: Deployment Execution defines the schemas, Rails renders and validates against them by reflection, and neither side hard-codes the other's fields.

### Pipeline config

The pipeline config is a generic, driver-invariant data structure. It lives in its own gem — separate from any driver — that the Deployment Execution team owns and the driver gems depend on. A driver's `supported_pipeline_steps` draws from the step types this gem defines. To add a step type, add it to the pipeline gem; a driver opts in once its workflow can enact it. The schema is the same for every pipeline and every driver — there is no Argo-specific pipeline config.

A pipeline's **deploy nodes** carry two things: generic CD parameters (which Environment, ordering, gates) and a slot holding an **opaque Application-Environment config blob** — for the Argo driver, the traffic-splitting strategy and load-balancing choice. Rails does not introspect that blob beyond rendering and validating it against the driver's Application-Environment schema. The blob lives embedded in the deploy node, not in a separate table.

So the split is clean: the pipeline structure is generic and Rails understands it; the per-node deploy config is driver-specific and Rails treats it as opaque data validated by reflection.

## Onboarding

Onboarding has two phases: Rails creates the domain entities (synchronous, transactional), then AutoFlow verifies connectivity and validates the user's configuration (async, durable, policy-governed). Nothing is installed; nothing is created in the cluster until the first deploy.

### Phase 1: domain entity creation (Rails)

The user fills out the onboarding form. Rails creates the domain entities in one transaction — Application, Services with their artifact sources, Environment, and the per-Environment driver binding. The driver binding holds `driver_ref` plus the Environment config the UI collected by reflecting over the driver's Environment config schema. The full entity model is in GitLab CD: Rails.

All entities exist immediately. They're just not ready yet.

### Phase 2: environment onboarding (AutoFlow)

Rails submits the driver's onboarding workflow. For the Argo driver, it checks `agentk` connectivity and confirms both controllers are running — through `k8s.get` against well-known objects:

```starlark
result = run("k8s.get", {
    "agent_id": environment.agent_id,
    "kind": "Deployment",
    "namespace": "argo-rollouts",
    "name": "argo-rollouts",
})

if not result.found:
    run("emit", {
        "type": "com.gitlab.cd.environment.not_ready",
        "data": {"environment_id": environment.id, "reason": "argo-rollouts controller not found"},
    })
    fail("argo-rollouts controller not found")

run("emit", {
    "type": "com.gitlab.cd.environment.ready",
    "data": {"environment_id": environment.id},
})
```

A different driver would check different things — a Lambda driver would verify IAM credentials and region access. The domain model doesn't know or care; it just stores the driver binding and submits the driver's `Starlark`.

Installing and managing controllers on behalf of users is out of scope. That path has failed before (GMA v1/v2) — we don't have the capacity to operate thousands of installations across clusters we don't own, and users end up blaming us for problems we can't diagnose. GitLab CD connects to Environments. It does not provision them.

### Phase 3: application-environment setup (AutoFlow)

Once the Environment is ready, the driver validates each application's manifest against the declared services. It reads the manifest from Git and parses the Argo `Rollout` CR:

```starlark
manifest = run("git.read_file", {
    "repo_url": app_env.manifest_repo_url,
    "ref": app_env.manifest_ref,
    "path": app_env.manifest_file_path,
})

rollout = parse_yaml(manifest)
declared = [s.container_name for s in app_env.services]
found = [c["name"] for c in rollout["spec"]["template"]["spec"]["containers"]]

if sorted(declared) != sorted(found):
    run("emit", {
        "type": "com.gitlab.cd.application_environment.not_ready",
        "data": {"application_environment_id": app_env.id, "reason": "container mismatch"},
    })
    fail("container mismatch")

run("emit", {
    "type": "com.gitlab.cd.application_environment.ready",
    "data": {
        "application_environment_id": app_env.id,
        "rollout_name": rollout["metadata"]["name"],
        "rollout_namespace": rollout["metadata"]["namespace"],
    },
})
```

The driver reads the manifest, parses the `Rollout` CR, and validates that its container names match the declared services. Rails persists the discovered name and namespace for use by later deployment workflows.

For an existing Argo CD `Application`, the setup workflow also confirms auto-sync is off. GitLab CD controls when syncs happen, and an Application left on auto-sync would fight the driver. The workflow checks `spec.syncPolicy` and emits `not_ready` if automated sync is on, so the mismatch surfaces at setup instead of mid-deploy.

The Argo CD `Application` CR itself is created on first deploy — configured with no `syncPolicy` so GitLab CD controls when syncs happen. The user's Git repo and workflow are undisturbed.

### Onboarding existing workloads

SHA pinning makes onboarding existing workloads significantly easier. Users who already have Argo CD Applications just need to:

1. Disable auto-sync on their Application (or let GitLab CD do it).
2. Point GitLab CD at the existing `Application` CR.
3. GitLab CD takes over `targetRevision` and parameter overrides.

No migration, no downtime, no fighting with the reconciler. GitLab CD should emit updates about the reconciled SHA so we can show drift if the user turns auto-sync back on.

### What the user provides versus what GitLab generates

| What | User provides | GitLab generates |
|---|---|---|
| Argo CD Core | Installed in cluster | — |
| Argo Rollouts controller | Installed in cluster | — |
| Argo CD `Application` CR | Manifest repo URL plus credentials plus file path | Created by the driver on first deploy |
| Artifact sources | Container name plus registry URL plus credentials | — |
| Rollout strategy | Canary steps, gates, rollback policy (the Application-Environment config) | `spec.strategy` YAML generated by the driver at deploy time |

Cluster prerequisites: a running `agentk` plus Argo CD Core and Argo Rollouts installed. Everything else flows through the driver.

If a workflow fails — bad credentials, unreachable cluster, wrong file path — the domain entities still exist. The user fixes the problem in the UI and retries. The workflow replays from the failed step.

## Health status monitoring

The deployment workflow observes one thing: the Argo `Rollout` CR. Sync confirmation is the driver's concern — `argo.sync` returns once the desired SHA has been applied to the Argo CD `Application` CR and the sync is in flight. From that point on, the workflow watches the `Rollout` CR for progression.

### Argo Rollout status

The `Rollout` CR provides canary progression details:

- `status.phase` — `Healthy`, `Progressing`, `Paused`, `Degraded`
- `status.currentStepIndex` — which gate the canary has reached
- `status.pauseConditions` — why the rollout is paused (for example `CanaryPauseStep`)
- `status.message` — human-readable status

This is what drives the workflow's state machine — `Paused` means a gate was reached, `Healthy` means the deployment finished, `Degraded` means something went wrong.

### Argo CD Application status (driver-internal)

The driver uses the `Application` CR internally to confirm that a given SHA has synced before returning from `argo.sync`. `status.sync.revision` matching the pinned SHA is how the driver knows its changes landed. The workflow watches the `Rollout` CR for runtime health; the `Application` CR is the driver's own sync check.

## The deployment flow

### Step 1: new version detected

An artifact source detects a new container image version. The source varies:

- GitLab Container Registry emits an internal event through the Events Platform.
- External registries (ECR, Artifactory) send a webhook or are polled by GitLab.

The event flows through the [Events Platform](https://gitlab.com/gitlab-com/content-sites/handbook/-/merge_requests/18106) into a CD Sidekiq worker in Rails.

The worker consults the CD tables:

1. Which Services have an artifact source matching this registry and image?
2. Create a new Version record on each matching artifact source.
3. For each affected Application, assemble a new VersionSet — the latest Version for every Service.

The VersionSet is now available. **No deployment happens yet.** AutoFlow is not involved.

### Step 2: user creates a Rollout

A user (or policy) decides to promote a VersionSet across one or more Environments. This creates a Rollout record in the CD tables with state `Pending`. The Rollout pins the VersionSet, the pipeline (flow definition) version, and the driver binding at creation. All of it is immutable from that point.

Rails submits one workflow to AutoFlow through `StartWorkflow` — the driver's deployment `Starlark`, with the Rollout's pinned configurations as input. The single workflow promotes the VersionSet from environment to environment until done. Rails stores the `workflow_id` on the Rollout.

Rollback works the same way. A user creates a new Rollout targeting a prior VersionSet. The mechanism is identical — same driver, same workflow, prior VersionSet. Every VersionSet is preserved in the CD tables, so rollback to any point is always available. Rollback never mutates an existing Rollout; it is a new one.

### Step 3: rollout coordination

The Rollout workflow promotes the VersionSet across Environments in order — staging, then production, and so on. Within an Environment, it drives the gates for each Deployment (one per `(service, environment)`), waits for all of them to reach each gate, and only advances to the next gate when they're all there.

```starlark
run("emit", {
    "type": "com.gitlab.cd.rollout.started",
    "data": {"rollout_id": rollout.id},
})

for environment in rollout.environments:
    for gate in pipeline.gates:
        for deployment in deployments_for(environment):
            advance_one(deployment, gate.weight)

        for deployment in deployments_for(environment):
            wait_for_event(
                type="com.gitlab.cd.deployment.gate_reached",
                filter={"deployment_id": deployment.id, "weight": gate.weight},
            )

        run("emit", {
            "type": "com.gitlab.cd.rollout.gate_reached",
            "data": {"rollout_id": rollout.id, "environment_id": environment.id, "weight": gate.weight},
        })

    for deployment in deployments_for(environment):
        wait_for_event(
            type="com.gitlab.cd.deployment.healthy",
            filter={"deployment_id": deployment.id},
        )

run("emit", {
    "type": "com.gitlab.cd.rollout.healthy",
    "data": {"rollout_id": rollout.id},
})
```

Each Deployment advances at its own pace — different soak durations, different health-check timing. The Rollout waits until everyone in an Environment is caught up before moving to the next gate, and until an Environment is healthy before moving to the next Environment. This gives coordination without forcing identical timing.

If any Deployment reports `degraded`, the workflow stops advancing and surfaces the failure. Recovery is a new Rollout (rollback) targeting a prior VersionSet — there is no rollback state on the existing Rollout. Approval happens at the Rollout level, not per-Deployment.

### Step 4: deployment execution

Each Deployment is the actuation for a single `(service, environment)` pair. The driver `Starlark` reads the current manifest, pins the new versions, commits, syncs, and then advances the canary one gate at a time as the Rollout coordination tells it to:

```starlark
run("emit", {
    "type": "com.gitlab.cd.deployment.started",
    "data": {"deployment_id": deployment.id},
})

# Read current desired state, pin the new versions from the VersionSet,
# and generate the canary strategy from the Application-Environment config.
manifest = run("git.read_file", {
    "repo_url": app_env.manifest_repo_url,
    "ref": app_env.manifest_ref,
    "path": app_env.manifest_file_path,
})
desired = pin_versions(manifest, version_set)
desired = apply_strategy(desired, app_env.config)  # opaque app-env blob, interpreted here

sha = run("git.commit", {
    "repo_url": app_env.manifest_repo_url,
    "branch": app_env.manifest_branch,
    "path": app_env.manifest_file_path,
    "content": desired,
    "message": "Deploy %s to %s" % (version_set.id, environment.name),
})

run("argo.sync", {
    "agent_id": environment.agent_id,
    "app_name": app_env.app_name,
    "app_namespace": app_env.app_namespace,
    "revision": sha,
})

while True:
    rollout_cr = run("k8s.get", {
        "agent_id": environment.agent_id,
        "kind": "Rollout",
        "namespace": app_env.rollout_namespace,
        "name": app_env.rollout_name,
    })

    phase = rollout_cr["status"]["phase"]

    if phase == "Paused":
        step_index = rollout_cr["status"]["currentStepIndex"]
        weight = pipeline.gates[step_index].weight

        run("emit", {
            "type": "com.gitlab.cd.deployment.gate_reached",
            "data": {"deployment_id": deployment.id, "weight": weight},
        })

        advance = wait_for_event(
            type="com.gitlab.cd.deployment.advance",
            filter={"deployment_id": deployment.id},
        )

        if pipeline.gates[step_index].soak_duration:
            sleep(seconds=pipeline.gates[step_index].soak_duration)

        # Idempotent: re-running against an already-advanced stop point is a no-op.
        run("argo.promote", {
            "agent_id": environment.agent_id,
            "rollout_name": app_env.rollout_name,
            "rollout_namespace": app_env.rollout_namespace,
            "step_index": step_index,
        })

    elif phase == "Healthy":
        run("emit", {
            "type": "com.gitlab.cd.deployment.healthy",
            "data": {"deployment_id": deployment.id},
        })
        break

    elif phase == "Degraded":
        run("emit", {
            "type": "com.gitlab.cd.deployment.degraded",
            "data": {"deployment_id": deployment.id},
        })
        break

    else:  # Progressing
        sleep(seconds=30)  # Beta polls; k8s.watch replaces this loop later.
```

The workflow never touches the cluster directly. Everything target-specific — generating the canary strategy, committing the manifest, syncing Argo CD, advancing past a pause — is in the driver's Functions and `Starlark`. The workflow describes desired state and reacts to status.

On `Degraded`, the Deployment workflow emits and exits. It does not abort the canary itself. The Rollout coordination decides what to do at the Application level — typically surface the failure and let the user create a rollback Rollout to keep things consistent.

#### The generated strategy

The driver generates a canary strategy where every traffic increment is gated by an indefinite `pause: {}`. The controller can never advance on its own.

For an Application-Environment config with steps at 5%, 25%, 50%, 100%:

```yaml
spec:
  strategy:
    canary:
      steps:
        - setWeight: 5
        - pause: {}
        - setWeight: 25
        - pause: {}
        - setWeight: 50
        - pause: {}
        - setWeight: 100
        - pause: {}
```

Each `argo.promote` clears one pause and lets the controller advance one gate. The promote is idempotent — the stop point identifies which pause, so a replay against an already-cleared pause does nothing.

#### Observation: poll now, watch later

For the Beta the deployment workflow polls the `Rollout` CR with `k8s.get` on a ~30s loop. It's simple and it works.

`k8s.watch` is the push replacement — a subscription through `agentk` that pushes `Rollout` status events back into AutoFlow over a `signal_channel`, giving the workflow a tight connection to the cluster. That's deferred behind the polling loop for the Beta. When it lands, the loop body selects on the channel instead of sleeping, and the rest of the flow is unchanged. The push event looks like this:

```json
{
  "specversion": "1.0",
  "type": "com.gitlab.cd.argo.rollout.status_changed",
  "source": "/agents/42/namespaces/production/rollouts/payments-api",
  "data": {
    "agent_id": 42,
    "rollout_name": "payments-api",
    "namespace": "production",
    "phase": "Paused",
    "current_step_index": 1,
    "stable_rs": "abc123",
    "current_pod_hash": "def456",
    "pause_conditions": [{"reason": "CanaryPauseStep"}],
    "abort": false
  }
}
```

### Step 5: rollback

Rollback is a new Rollout targeting a prior VersionSet. There is no rollback state on the existing Rollout, and the existing Rollout records never mutate. The driver runs the same deployment `Starlark` with the prior VersionSet's versions. It commits the prior desired state and syncs — the Argo controller detects the stable template and fast-tracks to `Healthy` without running canary steps.

Rollback is distinct from abort. Abort stops the canary and leaves the Argo `Rollout` in `Degraded` with the new (failed) version still in spec. Rollback re-points desired state to a known-good VersionSet — the controller recognizes the stable template and immediately marks `Healthy`.

| Operation | Mechanism | Result |
|---|---|---|
| Abort | Driver patches `status.abort: true` | `Degraded`. Stable RS serving. New version still in spec. |
| Rollback | New Rollout with a prior VersionSet, committed and synced | `Healthy`. Controller detects stable template, skips steps. |
| Retry | Driver patches `status.abort: false` | Restarts canary from step 0 with same new version. |

Default rollback policy: a new rollback Rollout is created immediately on `Failed`, and after 30 minutes on `Degraded` (Services may be temporarily unstable at startup). Both configurable at the Application level.

### Human-in-the-loop

HITL works at two levels:

**Inline in the workflow.** The driver's `Starlark` can encode approval gates directly — a `wait_for_event` that parks until `com.gitlab.cd.approval.resolved` arrives. The user configures this as part of the pipeline config ("require approval at 50%").

**Policy around Function calls.** AutoFlow evaluates policy (inherited from instance to organization to group to project, plus anything embedded in the workflow) on every `run` call. Policy can require approval for any Function — for example "all `argo.sync` calls against production need approval." The workflow parks transparently.

Both mechanisms use the same primitive: park, emit event, wait for approval event, replay.

## Built-in Function summary

All Functions run in GitLab Relay for the Beta — Go, imported in-process. They are not gRPC. They must be lightweight — Relay is a shared control plane, not a workload environment. OCI and remote Functions are deferred.

Once AutoFlow has Runner integration, any Function can be offloaded to a Runner environment. The workflow doesn't change — `run("argo.sync", ...)` works the same whether Relay executes it in-process or dispatches it to a Runner.

| Function | Runs in | Purpose |
|---|---|---|
| `emit` | Relay -> Events Platform | Publish a CD domain event. Called through `run` for replay idempotence. |
| `git.read_file` | Relay (in-process) | Read a file from a Git repo at a ref. |
| `git.commit` | Relay (in-process) | Commit file changes to a Git repo. Returns the new SHA. |
| `argo.sync` | Relay -> `agentk` | Sync an Argo CD `Application` to a specific SHA. |
| `argo.promote` | Relay -> `agentk` | Advance an Argo `Rollout` past a pause/stop point. Idempotent. |
| `k8s.get` | Relay -> `agentk` | Fetch a Kubernetes object. Beta polls with this. |
| `k8s.watch` | Relay -> `agentk` | Push subscription to Kubernetes object events. Deferred for the Beta. |

## What needs to be built

| Component | Status | Notes |
|---|---|---|
| AutoFlow engine | Being built | Durable workflow with `run`, `sleep`, `wait_for_event`. [gitlab-org/cluster-integration/gitlab-agent#821](https://gitlab.com/gitlab-org/cluster-integration/gitlab-agent/-/work_items/821) |
| `AutoFlow.StartWorkflow` RPC | New | Imperative gRPC endpoint for Rails to submit the driver's `Starlark`. |
| Events Platform | In design | CloudEvent bus through KAS. [gitlab-com/content-sites/handbook!18106](https://gitlab.com/gitlab-com/content-sites/handbook/-/merge_requests/18106) |
| Argo Rollouts Deploy Driver (Ruby gem) | New | The manifest, the `Starlark` workflows (onboarding, app-env setup, deploy), and the Environment and Application-Environment config schemas. Built by Deployment Execution, imported by the monolith, kept separate from the CD models. |
| CD tables in Rails | New | See GitLab CD: Rails. |
| CD Sidekiq workers | New | Consume CD domain events from the Events Platform, update entity state in the CD tables. |
| `Gitlab::Kas::Client#start_workflow` | New | Rails-side gRPC client for `StartWorkflow`. Follows the pattern of `send_autoflow_event`. |
| Built-in CD Functions | New | `git.read_file`, `git.commit`, `argo.sync`, `argo.promote`, `k8s.get` for the Beta; `k8s.watch` deferred. Go, in-process in Relay. [&22116](https://gitlab.com/groups/gitlab-org/-/work_items/22116) |
| `emit` Function | New | Publish a CloudEvent to the Events Platform. |
| `k8s.watch` push subscriptions | Deferred | Push interest from inside Relay, have `agentk` push events back, clean up on workflow exit. Replaces the Beta polling loop. @ash2k has confirmed this is feasible. |

## Open questions

**Event-to-workflow matching.** `wait_for_event` is defined as an AutoFlow primitive, but the mechanism for matching an incoming CloudEvent to a parked workflow is not designed yet. This design depends on it — Rollout-to-Deployment coordination uses events, approval events wake parked gates, and `k8s.watch` (when it lands) wakes deployment workflows. The matching system (subscription-based? fan-out with filtering? indexed by workflow id?) needs to be part of the [AutoFlow](https://gitlab.com/groups/gitlab-org/-/work_items/21235) design.

**`k8s.watch` push subscriptions.** The [Graph API](https://gitlab.com/gitlab-org/cluster-integration/gitlab-agent/-/blob/master/doc/graph_api.md) is pull-based today. `k8s.watch` needs push: register a subscription from inside Relay, have `agentk` push events back, and clean up on workflow exit. @ash2k has confirmed this is feasible. Deferred behind the Beta polling loop.

**Argo CD Application CR creation.** The driver creates the `Application` CR on first deploy. Users onboarding existing workloads point GitLab CD at an existing CR. Is that the right default, or do we want users to always provide the CR? Awaiting input from @gabrielengel_gl.

**Policy engine.** Policy will be Cedar, evaluated by the Auth Stack (AUTH-014 ADR). How that lines up with `run()` interception — for example "require approval for all production `argo.sync` calls" — is still being worked out separately.

**Strategy generation UI.** Rails renders the Application-Environment config UI by reflecting over the driver's schema. The generated `spec.strategy` YAML is an implementation detail — users configure canary steps and gate behaviors, never the YAML.

**External Git forges.** The Beta supports GitLab-hosted manifest repos. GitHub, Bitbucket, and other forges are a goal — most expose an API for reading and committing, but the credential model (personal tokens, project tokens, OAuth), how credentials are scoped, and where a `git` binary runs when an API isn't enough all need design work. Secrets are out of scope for the schema — they are resolved live by reference, never frozen into a Rollout.

**Workload references.** Argo Rollouts supports `spec.workloadRef` pointing to a separate Deployment, not just inline `spec.template`. Scope for the Beta or explicitly out? Awaiting input from @gabrielengel_gl.

**Log visibility.** Who sees deployment logs, and how they see them. CD deployment workflows log the same way any AutoFlow workflow does, so we sort it at the AutoFlow layer.
