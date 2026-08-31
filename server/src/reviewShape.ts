// The one place the review_summary shape is written down. `hive --help` prints
// REVIEW_SUMMARY_HELP and the ingest test runs REVIEW_SUMMARY_EXAMPLE through
// the real endpoint, so the help cannot drift from what the server accepts.
// It drifted once (hive-1947): the help said `check{options[]}` with bare-string
// options, which normalises to nothing, so agents emitted a review, minted no
// quiz, and sat in in_review blocked on a check they believed they had sent.

export const REVIEW_SUMMARY_HELP = `review_summary: --json review.json with {done[], iffy[{what,why}], decisions[], testing[],
        followups[], understanding{background, scope, essence, walkthrough[],
        affected_areas[], risk_assessment, participate,
        checks[{question, options[{key,label}], answer_key, explanation}]}}
        checks is an ARRAY; each options entry is a {key,label} OBJECT and
        answer_key must equal one of those keys. Bare-string options mint no
        quiz. Singular \`check\` is accepted as an alias and stored as checks[].`;

// A minimal payload that must always mint a quiz. Kept realistic, not empty:
// the test posts exactly this.
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
    checks: [
      {
        question: "What happens when a newer edit arrives while one is queued?",
        options: [
          { key: "a", label: "The newer edit replaces the queued one." },
          { key: "b", label: "The newer edit is dropped." },
        ],
        answer_key: "a",
        explanation: "The queue keeps the newest edit.",
      },
    ],
  },
};
