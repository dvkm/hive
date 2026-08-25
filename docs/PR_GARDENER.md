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
    "max_gardener_agents": 1
  }
}
```

`land_when` currently accepts only `green_and_clean`. A ready pull request must also link to an in-review Hive task because the normal merge path enforces review, dependency, authority, and merge-method rules.

Hive checks every open pull request against the configured base branch. If `promote.from` is set, that branch is the base. Otherwise Hive uses `default_branch` or `main`. The promote flow itself is unchanged.

The gardener never lands a task while the director is still deciding on it. Passing the Focus understanding quiz proves the director read the change. It is never approval to ship. Such a task waits until the director clicks Ship or answers a gardener card.

Sensitive pull requests always create a decision card. They are never landed or closed automatically. Hive always protects `.github/workflows/**`, `.env`, `**/*.env`, and files inside `secrets` directories. `sensitive_paths` adds project-specific patterns to those built-ins. A stale pull request also creates a card unless Git proves that every patch is already present on the base branch. `auto_close_superseded` defaults to false, so proven supersession still requires a card unless a project opts into automatic closure.

The sweep runs inside Hive's reconciler and never takes a project agent slot. Landing, closing, and decision cards also run there without an agent. Conflicts and failing checks create repair tasks in a separate gardener lane. That lane defaults to one agent per project and is capped by `max_gardener_agents`, so it cannot consume the project's `max_agents` feature-work slots. One repair task may be active for a pull request at a time. Repeated check failures stop at `max_fix_attempts` and create a decision card. Each sweep performs at most `max_actions_per_sweep` mutations. Decision cards do not count toward that cap.

The Projects screen shows the current queue and its reasons. The director can hold or release an item. The director can also approve a land or close action. Those actions run on the next sweep and remain subject to Hive's normal merge guardrails.

Each sweep sends one compact digest when it landed, closed, rebased, dispatched a check fix, or escalated at least one pull request.
