// HIVE-643: the intent drafter used to ask questions the ticket had already
// answered. WEB-163 spelled out the matching rule, where the add/remove happens,
// the scope, the empty-state copy and the sort order, and the draft still listed
// all six as open questions and left Constraints as "(not stated)". The work
// task then sat at the intent gate with nobody to ask.
//
// The fixture is WEB-163's own description. What is locked down here is the
// contract with the drafter: the prompt tells it to answer from the text and to
// ask only what the text never says, and a draft that comes back with nothing
// to ask is recorded as having nothing to ask.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-intent-web163-"));
process.env.HIVE_HOME = HOME;

const { openDb } = await import("../src/db.ts");
const { intentSection, openQuestions } = await import("../src/intents.ts");
const { DEFAULT_OPEN_QUESTION, buildDraftPrompt, draftIntentBody, sourceText } = await import("../src/intentDraft.ts");

// WEB-163, as the reporter wrote it.
const WEB_163 = `기사 목록 화면에 "자산" 탭을 하나 더 추가해주세요.

- 매칭 규칙: 기사 작성 화면의 자산 태그를 그대로 씁니다. 다른 규칙은 없습니다.
- 자산 태그는 CMS에서 추가/삭제가 가능해야 합니다.
- CMS 안에서만 보이면 됩니다. 프론트 노출은 이번 범위가 아닙니다.
- 범위: 매매거래, 개발 두 섹터 전체입니다.
- 정렬은 최신순이고, 드롭다운으로 바꿀 수 있게 해주세요.
- 해당 태그의 기사가 없을 때 문구: "등록된 자산 기사가 없습니다."

시안: 이미지 3`;

const MOCKUP = join(HOME, "briefs", "attachments", "WEB-163", "image-3.png");

const SRC = {
  title: "[WEB-163] 기사 목록에 자산 탭 추가",
  description: `${WEB_163}\n[attachment: image-3.png -> ${MOCKUP}]`,
  comments: [],
  attachments: [MOCKUP],
};

test("the drafter is told to answer from the ticket, not to ask it back", () => {
  const prompt = buildDraftPrompt(SRC);
  // The whole ticket reaches the model, images included.
  expect(prompt).toContain("기사 작성 화면의 자산 태그");
  expect(prompt).toContain("등록된 자산 기사가 없습니다.");
  expect(prompt).toContain(MOCKUP);
  expect(sourceText(SRC)).toContain("already downloaded and readable at these paths");
  // And the three instructions that were missing.
  expect(prompt).toContain("READ ALL OF IT FIRST");
  expect(prompt).toContain("ANSWER IT YOURSELF");
  expect(prompt).toContain("Return an empty\n  array when the request settles everything");
  expect(prompt).toContain('name that file\'s local path in "constraints"');
  // The old rule forced a question even when the ticket answered everything.
  expect(prompt).not.toContain("open_questions: at least one");
});

// The draft WEB-163 should have produced: every answer as a constraint, nothing
// left to ask.
const DRAFTED = JSON.stringify({
  problem: "기사 목록 화면에 자산 탭이 없습니다.",
  proposed_outcome: "CMS 기사 목록에 자산 탭이 생기고, 자산 태그가 붙은 기사가 최신순으로 보입니다.",
  affected: "CMS 기사 목록 화면, 기사 작성 화면의 자산 태그.",
  constraints: [
    "매칭 규칙은 기사 작성 화면의 자산 태그를 그대로 쓴다.",
    "자산 태그는 CMS에서 추가/삭제할 수 있어야 한다.",
    "범위는 매매거래와 개발 두 섹터 전체, CMS 안에서만 보인다.",
    "정렬은 최신순이고 드롭다운으로 바꿀 수 있다.",
    '기사가 없을 때 문구는 "등록된 자산 기사가 없습니다."',
    `시안은 ${MOCKUP}`,
  ].join("\n"),
  open_questions: [],
});

const stubModel = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

test("a ticket that answers everything drafts with no open questions and real constraints", async () => {
  const db = openDb(":memory:");
  const draft = await draftIntentBody(db, SRC, { model: stubModel(DRAFTED) as any });
  expect(draft.drafted).toBe(true);

  expect(openQuestions(draft.body_md)).toEqual([]);
  const constraints = intentSection(draft.body_md, "Constraints").split("\n").filter(Boolean);
  expect(constraints.length).toBeGreaterThanOrEqual(4);
  expect(intentSection(draft.body_md, "Constraints")).toContain("기사 작성 화면의 자산 태그");
  expect(intentSection(draft.body_md, "Constraints")).toContain("추가/삭제");
  expect(intentSection(draft.body_md, "Constraints")).toContain("매매거래");
  expect(intentSection(draft.body_md, "Constraints")).toContain("최신순");
  // The mockup is named where the builder will look for it.
  expect(intentSection(draft.body_md, "Constraints")).toContain(MOCKUP);
});

test("a draft that never answered the question still carries the default one", async () => {
  const db = openDb(":memory:");
  const draft = await draftIntentBody(db, SRC, {
    model: stubModel(JSON.stringify({ problem: "p", proposed_outcome: "o" })) as any,
  });
  expect(openQuestions(draft.body_md)).toEqual([DEFAULT_OPEN_QUESTION]);
});
