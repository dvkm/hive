import { expect, test } from "bun:test";
import {
  agentPlatformEnv,
  buildExecutablePath,
  commandForCurrentShell,
  findGitBash,
  isPortableAbsolutePath,
  resolveConfiguredCommand,
} from "../src/platform.ts";
import { discoverHerdrBin, hiveCliPath } from "../src/runtime/herdr.ts";
import { appBrowserCandidates, installedHiveAppCandidates, openUrlArgv } from "../../cli/platform.ts";

test("portable path helpers recognize and resolve Windows paths", () => {
  expect(isPortableAbsolutePath("C:\\Users\\Ada\\repo")).toBe(true);
  expect(isPortableAbsolutePath("\\\\server\\share\\repo")).toBe(true);
  expect(isPortableAbsolutePath("/Users/ada/repo")).toBe(true);
  expect(isPortableAbsolutePath("C:repo")).toBe(false);
  expect(resolveConfiguredCommand("C:\\Users\\Ada\\repo", "tools\\setup.cmd")).toBe(
    "C:\\Users\\Ada\\repo\\tools\\setup.cmd"
  );
  expect(resolveConfiguredCommand("C:\\Users\\Ada\\repo", "bun")).toBe("bun");
  expect(resolveConfiguredCommand("C:\\Users\\Ada\\repo", "setup.ps1")).toBe(
    "C:\\Users\\Ada\\repo\\setup.ps1"
  );
});

test("Windows process environments retain drive paths and expose Git Bash", () => {
  const env = {
    PATH: "C:\\Tools;D:\\Bin",
    USERPROFILE: "C:\\Users\\Ada",
    ProgramFiles: "C:\\Program Files",
  };
  const path = buildExecutablePath(env.PATH, "win32", env);
  expect(path.split(";")).toContain("C:\\Tools");
  expect(path.split(";")).toContain("C:\\Users\\Ada\\.bun\\bin");
  expect(findGitBash(env, (candidate) => candidate === "C:\\Program Files\\Git\\bin\\bash.exe")).toBe(
    "C:\\Program Files\\Git\\bin\\bash.exe"
  );
  expect(agentPlatformEnv(env, "win32", (candidate) => candidate === "C:\\Program Files\\Git\\bin\\bash.exe")).toMatchObject({
    CLAUDE_CODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe",
  });
});

test("hook commands use shell-safe forward slashes on Windows", () => {
  expect(commandForCurrentShell(["bun", "C:\\Projects\\Hive App\\hooks\\hive-hook.ts", "Stop"], "win32")).toBe(
    'bun "C:/Projects/Hive App/hooks/hive-hook.ts" Stop'
  );
  expect(hiveCliPath("win32")).not.toContain("\\");
});

test("Herdr discovery includes its native per-user install", () => {
  const expected = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe";
  expect(
    discoverHerdrBin(
      { USERPROFILE: "C:\\Users\\Ada", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
      "win32",
      () => null,
      (candidate) => candidate === expected
    )
  ).toBe(expected);
});

test("CLI app launchers expose native Windows commands and install locations", () => {
  const env = {
    USERPROFILE: "C:\\Users\\Ada",
    LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
  };
  expect(openUrlArgv("http://127.0.0.1:4700", "win32")).toEqual([
    "explorer.exe",
    "http://127.0.0.1:4700",
  ]);
  expect(installedHiveAppCandidates(env, "win32")).toEqual([
    "C:\\Users\\Ada\\AppData\\Local\\Programs\\hive\\hive.exe",
  ]);
  expect(appBrowserCandidates(env, "win32")).toContain(
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  );
});
