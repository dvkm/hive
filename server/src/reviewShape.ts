// The one place the review_summary shape is written down. `hive --help` prints
// REVIEW_SUMMARY_HELP and the ingest test runs REVIEW_SUMMARY_EXAMPLE through
// the real endpoint, so the help cannot drift from what the server accepts.

export const REVIEW_SUMMARY_HELP = `review_summary: --json review.json with {done[], iffy[{what,why}], decisions[], testing[],
        followups[], understanding{background, scope, essence, walkthrough[],
        affected_areas[], risk_assessment, participate}}
        Write the file inside your task's worktree or session scratchpad — a
        shared path like /tmp/review.json is REFUSED, because a second agent
        writing the same file publishes its review under your task.`;

// A realistic payload, not an empty one: the test posts exactly this.
export const REVIEW_SUMMARY_EXAMPLE = {
  done: ["fixed the save flow"],
  iffy: [{ what: "used a global lock", why: "throughput is untested" }],
  decisions: ["kept the existing queue"],
  testing: ["bun test server/test/reviewShape.test.ts"],
  followups: ["measure lock contention"],
  understanding: {
    background: "Drafts were lost when two edits landed together.",
    scope: "The editor queue and the offline-save path.",
    essence: "The newest edit now replaces the queued one.",
    walkthrough: ["An edit enters the queue.", "The newest edit wins."],
    affected_areas: ["Draft editor", "Offline saves"],
    risk_assessment: "A browser shutdown can still interrupt a save.",
    participate: "Try saving twice in a row with the network off.",
  },
};
