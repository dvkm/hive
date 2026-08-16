# `hive learning add` requires `--kind` (task #904)

Two real hive daemons were run side by side against throwaway DBs: one on the base commit `4661487`, one on the fix `d8dd42f`. Both got the identical command sequence, driven through the real `bin/hive` CLI, the HTTP API, and the web UI.

| file | what it shows |
| --- | --- |
| [01-cli-before-after.txt](01-cli-before-after.txt) | The corebeat watcher scenario replayed on both builds: base silently files routine triage summaries as failures and spawns a bogus `Root cause:` chore; the fix exits 1 with `--kind is required`. |
| [02-cli-correct-usage.txt](02-cli-correct-usage.txt) | The same watcher with `--kind reference` (files as a reference), `--kind reference --root-cause` (rejected), and a genuine `--kind failure --root-cause` (still spawns the chore). |
| [03-kind-correction-path.txt](03-kind-correction-path.txt) | Base: `PUT {kind:"reference"}` returns 200 and the row stays `failure` (misfile permanent). Fix: the same PUT flips the kind, clears `root_cause_task_id`, and cancels the queued chore. |
| [04-api-response-matrix.txt](04-api-response-matrix.txt) | Direct `POST /api/learnings` (the path curl and the web UI share): missing kind, bogus kind, and `reference` + `create_root_cause_task` are 400 on the fix, 201 on base. |
| [05-agent-brief-before-after.txt](05-agent-brief-before-after.txt) | The composed agent brief: base pins four routine notes under "Known failure patterns" and its own instruction line omits `--kind`; the fix pins only genuine regressions and the instruction now says `--kind failure`. |
| [learnings-view-after-correction.png](learnings-view-after-correction.png) | Web Learnings view on the fix build: the corrected cycle-33 note renders under References, the genuine regression keeps its root-cause task chip. |
| [root-cause-chore-cancelled.png](root-cause-chore-cancelled.png) | The auto-spawned chore after the correction: state Cancelled, timeline reads `cancelled: learning recategorized from failure to reference`. |

The one bit of behavior no artifact covers directly is the live corebeat data: the fix was exercised against throwaway databases only, nothing was deployed or mutated on hive-live.
