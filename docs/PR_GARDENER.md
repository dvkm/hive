# PR Gardener

PR Gardener is an optional project reconciler that reviews open feature pull requests on a fixed cadence. It uses the existing Hive merge path, task dispatcher, decision cards, notifications, and project base branch rules.

It is off by default. Enable it by adding `pr_gardener` to a project's config:

```json
{
  "pr_gardener": {
    "enabled": true,
    "cadence": "30m",
    "land_when": "green_and_clean",
    "close_stale_after": "14d",
    "auto_close_superseded": false,
    "sensitive_paths": [
      "deploy/prod/**",
      "src/auth/**",
      "newsletter/SEND_LIVE"
    ],
    "max_actions_per_sweep": 5,
    "max_fix_attempts": 2,
    "max_gardener_agents": 1,
    "adopt_untracked": false,
    "adopt_skip_labels": ["no-hive", "do-not-adopt"]
  }
}
```

`land_when` currently accepts only `green_and_clean`. A ready pull request must also link to an in-review Hive task because the normal merge path enforces review, dependency, authority, and merge-method rules.

Hive checks every open pull request against the configured base branch. If `promote.from` is set, that branch is the base. Otherwise Hive uses `default_branch` or `main`. The promote flow itself is unchanged.

The gardener never lands a task while the director is still deciding on it. Passing the understanding quiz proves the director read the change, on any surface: Focus, the review card, or the task page. It is never approval to ship. Such a task waits until the director clicks Ship or answers a gardener card.

Sensitive pull requests always create a decision card. They are never landed or closed automatically. Hive always protects `.github/workflows/**`, `.env`, `**/*.env`, and files inside `secrets` directories. `sensitive_paths` adds project-specific patterns to those built-ins. A stale pull request also creates a card unless Git proves that every patch is already present on the base branch. `auto_close_superseded` defaults to false, so proven supersession still requires a card unless a project opts into automatic closure.

The sweep runs inside Hive's reconciler and never takes a project agent slot. Landing, closing, and decision cards also run there without an agent. Conflicts and failing checks create repair tasks in a separate gardener lane. That lane defaults to one agent per project and is capped by `max_gardener_agents`, so it cannot consume the project's `max_agents` feature-work slots. One repair task may be active for a pull request at a time. Repeated check failures stop at `max_fix_attempts` and create a decision card. Each sweep performs at most `max_actions_per_sweep` mutations. Decision cards do not count toward that cap.

The Projects screen shows the current queue and its reasons. The director can hold or release an item. The director can also approve a land or close action. Those actions run on the next sweep and remain subject to Hive's normal merge guardrails.

## Adopting untracked pull requests

Set `adopt_untracked` to true and each sweep also records the open pull requests that no Hive task tracks yet. These are the ones a human or another tool opened, so Hive never saw them and the gardener could not act on them.

Hive lists every open pull request in the repo for this step, not just the ones on the configured base branch. A hotfix opened straight against `main` therefore gets recorded too, even though the gardener only grades pull requests on the base branch.

A pull request is skipped when it already carries the `hive-task:` footer or a `[hive-<n>]` title, when a Hive task already points at its URL, when it is a draft, or when it carries a label from `adopt_skip_labels`. Those defaults are `no-hive` and `do-not-adopt`. This is how you tell Hive to keep its hands off a pull request you are driving yourself.

Adoption creates one lightweight tracking task. It is a `source=external` task, which is Hive's existing record-only lane. Hive never spawns an agent for it and the merge path refuses it outright. Adoption only makes the pull request visible on the board and to the gardener. Landing it or closing it still needs you to answer a gardener decision card.

Adoption is idempotent. The lookup matches an existing task in any state, including a cancelled one, so a pull request you dismissed is never adopted again. When an adopted pull request stops being open, Hive cancels its tracking task so the board does not fill up.

The poll interval is the shared `cadence`. The repos in scope are the projects that turn `adopt_untracked` on.

Each sweep sends one compact digest when it adopted, landed, closed, rebased, dispatched a check fix, or escalated at least one pull request.
