import { describe, expect, test } from "bun:test";
import { parseTeamclaudeEnv, proxyUrl, applyTeamclaudeEnv, teamclaudeOverlay, usesTeamclaude } from "../src/teamclaude.ts";
import { agentForConfig, modelForTask } from "../src/api.ts";
import { plannerSpawnEnv } from "../src/planner.ts";

const MITM_OUTPUT = `export HTTPS_PROXY=http://127.0.0.1:3456
export HTTP_PROXY=http://127.0.0.1:3456
export https_proxy=http://127.0.0.1:3456
export http_proxy=http://127.0.0.1:3456
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy=localhost,127.0.0.1,::1
export NODE_EXTRA_CA_CERTS=/Users/ada/.config/teamclaude-ca.pem
unset ANTHROPIC_BASE_URL
# TeamClaude env: MITM forward-proxy mode, localhost:3456
# apply to this shell:  eval "$(teamclaude env)"
`;

describe("parseTeamclaudeEnv", () => {
  test("parses export and unset lines, skips comments", () => {
    const env = parseTeamclaudeEnv(MITM_OUTPUT);
    expect(env.set.HTTPS_PROXY).toBe("http://127.0.0.1:3456");
    expect(env.set.NODE_EXTRA_CA_CERTS).toBe("/Users/ada/.config/teamclaude-ca.pem");
    expect(env.unset).toEqual(["ANTHROPIC_BASE_URL"]);
    expect(Object.keys(env.set)).toHaveLength(7);
  });

  test("strips a quoted value", () => {
    const env = parseTeamclaudeEnv(`export NODE_EXTRA_CA_CERTS="/a b/ca.pem"`);
    expect(env.set.NODE_EXTRA_CA_CERTS).toBe("/a b/ca.pem");
  });

  test("proxyUrl prefers HTTPS_PROXY, falls back to base URL, else null", () => {
    expect(proxyUrl(parseTeamclaudeEnv(MITM_OUTPUT))).toBe("http://127.0.0.1:3456");
    expect(proxyUrl(parseTeamclaudeEnv("export ANTHROPIC_BASE_URL=http://127.0.0.1:3456"))).toBe("http://127.0.0.1:3456");
    expect(proxyUrl(parseTeamclaudeEnv("# nothing"))).toBeNull();
  });
});

describe("agent option", () => {
  test("only agent=teamclaude opts a project in", () => {
    expect(usesTeamclaude({ agent: "teamclaude" })).toBe(true);
    expect(usesTeamclaude({ agent: "claude" })).toBe(false);
    expect(usesTeamclaude({ agent: "codex" })).toBe(false);
    expect(usesTeamclaude({})).toBe(false);
  });

  test("teamclaude behaves as claude everywhere else (binary, hooks, models)", () => {
    expect(agentForConfig({ agent: "teamclaude" })).toBe("claude");
    expect(modelForTask({ agent: "teamclaude" }, "ship")).toBe("opus");
  });
});

describe("applyTeamclaudeEnv", () => {
  test("overlays exports and removes unset names", () => {
    const merged = applyTeamclaudeEnv(
      { PATH: "/bin", ANTHROPIC_BASE_URL: "http://stale:1", HTTPS_PROXY: "http://old:1" },
      parseTeamclaudeEnv(MITM_OUTPUT)
    );
    expect(merged.PATH).toBe("/bin");
    expect(merged.HTTPS_PROXY).toBe("http://127.0.0.1:3456");
    expect(merged.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("null teamclaude env is a no-op", () => {
    const base = { PATH: "/bin" };
    expect(applyTeamclaudeEnv(base, null)).toBe(base);
  });
});

// HIVE-491: with no ~/.hive/claude-profiles.json, claudeProfileEnvForRepo returns
// {}. That empty object used to be read as "route to the personal account", which
// took every server-side model call off the TeamClaude proxy and killed the whole
// review pipeline once the personal account hit its weekly limit.
describe("plannerSpawnEnv", () => {
  const TC = { set: { HTTPS_PROXY: "http://127.0.0.1:3456" }, unset: ["ANTHROPIC_BASE_URL"] };

  test("an empty project env still routes through TeamClaude", () => {
    const env = plannerSpawnEnv({ PATH: "/bin" }, {}, TC);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3456");
  });

  test("no project env still routes through TeamClaude", () => {
    expect(plannerSpawnEnv({ PATH: "/bin" }, undefined, TC).HTTPS_PROXY).toBe("http://127.0.0.1:3456");
  });

  test("a real route wins over TeamClaude and unsets nothing of its own", () => {
    const env = plannerSpawnEnv({ PATH: "/bin" }, { CLAUDE_CONFIG_DIR: "/home/ada/.claude-work" }, TC);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/ada/.claude-work");
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  test("an inherited CLAUDE_CONFIG_DIR is dropped when no route names one", () => {
    const env = plannerSpawnEnv({ CLAUDE_CONFIG_DIR: "/leaked" }, {}, null);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

// herdr agents get `--env K=V` overlays with no way to unset a name, so an
// unset ships as an empty value instead of being silently dropped.
describe("teamclaudeOverlay", () => {
  test("carries exports and blanks the unset names", () => {
    const overlay = teamclaudeOverlay(parseTeamclaudeEnv(MITM_OUTPUT));
    expect(overlay.HTTPS_PROXY).toBe("http://127.0.0.1:3456");
    expect(overlay.ANTHROPIC_BASE_URL).toBe("");
  });

  test("no proxy means no overlay", () => {
    expect(teamclaudeOverlay(null)).toEqual({});
  });
});
