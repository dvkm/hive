import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeProfilesPath,
  loadClaudeProfiles,
  selectClaudeConfigDir,
  type ClaudeProfilesConfig,
} from "../src/claudeProfiles.ts";

test("Windows profile routing is case-insensitive and respects path boundaries", () => {
  const config: ClaudeProfilesConfig = {
    default_config_dir: "C:\\Users\\me\\.claude",
    routes: [
      {
        root: "C:\\Users\\me\\Desktop\\FurnishUp",
        config_dir: "C:\\Users\\me\\.claude-furnishup",
      },
    ],
  };
  expect(selectClaudeConfigDir("c:\\users\\ME\\desktop\\furnishup\\floorplan", config)).toBe(
    "C:\\Users\\me\\.claude-furnishup"
  );
  expect(selectClaudeConfigDir("C:\\Users\\me\\Desktop\\FurnishUp-other\\floorplan", config)).toBe(
    "C:\\Users\\me\\.claude"
  );
});

test("the longest containing root wins and projects outside routes use personal", () => {
  const config: ClaudeProfilesConfig = {
    default_config_dir: "/Users/me/.claude",
    routes: [
      { root: "/Users/me/work", config_dir: "/Users/me/.claude-work" },
      { root: "/Users/me/work/sensitive", config_dir: "/Users/me/.claude-sensitive" },
    ],
  };
  expect(selectClaudeConfigDir("/Users/me/work/sensitive/app", config)).toBe("/Users/me/.claude-sensitive");
  expect(selectClaudeConfigDir("/Users/me/personal/app", config)).toBe("/Users/me/.claude");
  expect(selectClaudeConfigDir("/Users/me/personal/app", { routes: [] })).toBeNull();
});

test("routing config is machine-local under HIVE_HOME and rejects malformed paths", () => {
  const home = mkdtempSync(join(tmpdir(), "hive-claude-profiles-"));
  const file = claudeProfilesPath({ HIVE_HOME: home } as NodeJS.ProcessEnv, "/Users/me");
  writeFileSync(file, JSON.stringify({ routes: [{ root: "relative", config_dir: "/profiles/work" }] }));
  expect(() => loadClaudeProfiles(file)).toThrow("root must be an absolute path");
});
