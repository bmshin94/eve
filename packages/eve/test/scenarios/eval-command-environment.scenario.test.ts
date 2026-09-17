import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run.js";
import { loadDevelopmentEnvironmentFiles } from "../../src/cli/dev/environment.js";
import {
  clearActiveSandboxHandlesForTest,
  trackActiveSandboxHandle,
} from "../../src/execution/sandbox/active-handles.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const mockedEvalDependencies = vi.hoisted(() => ({
  createDevelopmentServer: vi.fn(),
  discoverAndImportEvals: vi.fn(),
  discoverEvalConfig: vi.fn(),
  executeEval: vi.fn(),
  resolveEvalTargetHandle: vi.fn(),
}));

vi.mock("../../src/evals/runner/discover.js", () => ({
  discoverAndImportEvals: mockedEvalDependencies.discoverAndImportEvals,
  discoverEvalConfig: mockedEvalDependencies.discoverEvalConfig,
}));

vi.mock("../../src/evals/runner/execute-eval.js", () => ({
  executeEval: mockedEvalDependencies.executeEval,
}));

vi.mock("../../src/evals/target.js", () => ({
  resolveEvalTargetHandle: mockedEvalDependencies.resolveEvalTargetHandle,
}));

vi.mock("../../src/internal/nitro/host.js", () => ({
  createDevelopmentServer: mockedEvalDependencies.createDevelopmentServer,
}));

const createScratchDirectory = useTemporaryDirectories();

const DEVELOPMENT_ENV_KEYS = [
  "EVE_DEV_DEFAULT_ONLY",
  "EVE_DEV_DEVELOPMENT_LOCAL_ONLY",
  "EVE_DEV_DEVELOPMENT_ONLY",
  "EVE_DEV_LOCAL_ONLY",
  "EVE_DEV_SHARED",
  "EVE_DEV_SHELL_ONLY",
  "EVE_EVALUATION",
  "EVE_EVALUATION_RUN_ID",
  "EVE_EVAL_SETUP_NEW",
] as const;

async function createEnvironmentFixture(): Promise<string> {
  const fixtureRoot = await createScratchDirectory("eve-eval-env-");

  await mkdir(join(fixtureRoot, "agent"), { recursive: true });
  await writeFile(
    join(fixtureRoot, "package.json"),
    `${JSON.stringify({ dependencies: { eve: "*" }, name: "eve-eval-env-test", private: true, type: "module" })}\n`,
  );
  await writeFile(
    join(fixtureRoot, "agent", "agent.mjs"),
    'export default { model: "openai/gpt-5.4" };\n',
  );
  await writeFile(join(fixtureRoot, "agent", "instructions.md"), "You are a precise assistant.\n");

  await writeFile(
    join(fixtureRoot, ".env"),
    [
      "EVE_DEV_DEFAULT_ONLY=from-env",
      "EVE_DEV_SHARED=from-env",
      "EVE_DEV_SHELL_ONLY=from-env",
    ].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, ".env.development"),
    ["EVE_DEV_DEVELOPMENT_ONLY=from-development"].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, ".env.local"),
    ["EVE_DEV_LOCAL_ONLY=from-local", "EVE_DEV_SHARED=from-local"].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, ".env.development.local"),
    ["EVE_DEV_DEVELOPMENT_LOCAL_ONLY=from-development-local"].join("\n"),
  );

  return fixtureRoot;
}

function clearDevelopmentEnvironment(): void {
  for (const key of DEVELOPMENT_ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearDevelopmentEnvironment();
  process.exitCode = undefined;
  vi.restoreAllMocks();
  clearActiveSandboxHandlesForTest();
  mockedEvalDependencies.createDevelopmentServer.mockReset();
  mockedEvalDependencies.discoverAndImportEvals.mockReset();
  mockedEvalDependencies.discoverEvalConfig.mockReset();
  mockedEvalDependencies.executeEval.mockReset();
  mockedEvalDependencies.resolveEvalTargetHandle.mockReset();
});

const TEST_CONFIG = {
  _tag: "EveEvalConfig" as const,
  judge: { model: "openai/gpt-5.4-mini" },
};

describe("eve eval environment loading", () => {
  it.each([
    "local",
    "remote",
    "startup failure",
    "eval failure",
    "close failure",
    "teardown failure",
  ])("keeps setup resources and environment overrides through %s", async (mode) => {
    const fixtureRoot = await realpath(await createEnvironmentFixture());
    const previousCwd = process.cwd();
    const logger = { error: vi.fn(), log: vi.fn() };
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const lifecycle: string[] = [];
    const expectOverrides = () => {
      expect(process.env.EVE_DEV_SHARED).toBe("from-setup");
      expect(process.env.EVE_DEV_SHELL_ONLY).toBeUndefined();
      expect(process.env.EVE_DEV_DEFAULT_ONLY).toBeUndefined();
      expect(process.env.EVE_EVAL_SETUP_NEW).toBe("new");
    };
    process.env.EVE_DEV_SHELL_ONLY = "from-shell";
    mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue([
      makeEvaluation("first"),
      makeEvaluation("second"),
    ]);
    mockedEvalDependencies.discoverEvalConfig.mockResolvedValue({
      ...TEST_CONFIG,
      async setup() {
        expect(process.env.EVE_DEV_SHARED).toBe("from-local");
        lifecycle.push("setup");
        return {
          env: {
            EVE_DEV_SHARED: "from-setup",
            EVE_DEV_SHELL_ONLY: undefined,
            EVE_DEV_DEFAULT_ONLY: undefined,
            EVE_EVAL_SETUP_NEW: "new",
          },
          async teardown() {
            expectOverrides();
            lifecycle.push("teardown");
            if (mode === "teardown failure") throw new Error("fixture teardown failed");
          },
        };
      },
    });
    mockedEvalDependencies.createDevelopmentServer.mockImplementation(() => {
      expectOverrides();
      return {
        async start() {
          lifecycle.push("start");
          // The host reloads env files before it copies the environment into its worker.
          await loadDevelopmentEnvironmentFiles(fixtureRoot);
          expectOverrides();
          if (mode === "startup failure") throw new Error("fixture startup failed");
          return { url: "http://127.0.0.1:43123" };
        },
        async close() {
          expectOverrides();
          lifecycle.push("close");
          if (mode === "close failure") throw new Error("fixture close failed");
        },
      };
    });
    mockedEvalDependencies.resolveEvalTargetHandle.mockImplementation(async () => {
      expectOverrides();
      return { kind: mode === "remote" ? "remote" : "local", url: "https://example.com" };
    });
    mockedEvalDependencies.executeEval.mockImplementation(async ({ evaluation }) => {
      expectOverrides();
      lifecycle.push("eval");
      return makeEvalResult(mode === "eval failure" ? "beta" : evaluation.id);
    });

    process.chdir(fixtureRoot);
    try {
      const run = runCli(
        ["eval", "--skip-report", ...(mode === "remote" ? ["--url", "https://example.com"] : [])],
        logger,
      );
      if (mode === "startup failure") await expect(run).rejects.toThrow("fixture startup failed");
      else await run;
    } finally {
      process.chdir(previousCwd);
    }

    const expectedLifecycle = ["setup"];
    if (mode !== "remote") expectedLifecycle.push("start");
    if (mode !== "startup failure") expectedLifecycle.push("eval", "eval");
    if (mode !== "remote") expectedLifecycle.push("close");
    expectedLifecycle.push("teardown");
    expect(lifecycle).toEqual(expectedLifecycle);
    expectOverrides();
    await loadDevelopmentEnvironmentFiles(fixtureRoot);
    expectOverrides();
    if (mode === "close failure" || mode === "teardown failure") {
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Eval cleanup failed:"));
    }
    if (mode !== "startup failure") {
      expect(exit).toHaveBeenCalledWith(mode.endsWith("failure") ? 1 : 0);
    }
  });

  it.each(["setup failure", "list", "excluded"])(
    "does not start a target after %s",
    async (mode) => {
      const fixtureRoot = await createEnvironmentFixture();
      const previousCwd = process.cwd();
      const setup = vi.fn(async () => {
        throw new Error("fixture setup failed");
      });
      mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue([
        { ...makeEvaluation("first"), tags: ["skip"] },
      ]);
      mockedEvalDependencies.discoverEvalConfig.mockResolvedValue({ ...TEST_CONFIG, setup });
      process.chdir(fixtureRoot);
      try {
        const args =
          mode === "list" ? ["--list"] : mode === "excluded" ? ["--exclude-tag", "skip"] : [];
        const run = runCli(["eval", ...args], { error: vi.fn(), log: vi.fn() });
        if (mode === "setup failure") await expect(run).rejects.toThrow("fixture setup failed");
        else await run;
      } finally {
        process.chdir(previousCwd);
      }
      expect(setup).toHaveBeenCalledTimes(mode === "setup failure" ? 1 : 0);
      expect(mockedEvalDependencies.createDevelopmentServer).not.toHaveBeenCalled();
      expect(mockedEvalDependencies.resolveEvalTargetHandle).not.toHaveBeenCalled();
    },
  );

  it("loads local env files before resolving a remote target", async () => {
    const fixtureRoot = await createEnvironmentFixture();
    const resolvedFixtureRoot = await realpath(fixtureRoot);
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const evaluation = {
      _tag: "EveEval" as const,
      id: "demo-eval",
      test: async () => {},
    };

    process.env.EVE_DEV_SHELL_ONLY = "from-shell";
    process.chdir(fixtureRoot);
    mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue([evaluation]);
    mockedEvalDependencies.discoverEvalConfig.mockResolvedValue(TEST_CONFIG);
    mockedEvalDependencies.resolveEvalTargetHandle.mockImplementation(async () => {
      expect(process.env.EVE_DEV_LOCAL_ONLY).toBe("from-local");
      return {
        attachSession: vi.fn(),
        capabilities: { devRoutes: false },
        dispatchSchedule: vi.fn(),
        fetch: vi.fn(),
        kind: "remote",
        url: "https://example.com",
      };
    });
    mockedEvalDependencies.executeEval.mockResolvedValue(makeEvalResult(evaluation.id));

    try {
      await runCli(["eval", "--url", "https://example.com"], logger);
    } finally {
      process.chdir(previousCwd);
    }

    expect(process.env.EVE_DEV_DEVELOPMENT_LOCAL_ONLY).toBe("from-development-local");
    expect(process.env.EVE_DEV_LOCAL_ONLY).toBe("from-local");
    expect(process.env.EVE_DEV_DEVELOPMENT_ONLY).toBe("from-development");
    expect(process.env.EVE_DEV_DEFAULT_ONLY).toBe("from-env");
    expect(process.env.EVE_DEV_SHARED).toBe("from-local");
    expect(process.env.EVE_DEV_SHELL_ONLY).toBe("from-shell");
    expect(mockedEvalDependencies.discoverAndImportEvals).toHaveBeenCalledWith(
      resolvedFixtureRoot,
      undefined,
    );
    expect(mockedEvalDependencies.resolveEvalTargetHandle).toHaveBeenCalled();
    expect(mockedEvalDependencies.executeEval).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("shuts down tracked sandbox handles after a local eval run", async () => {
    const fixtureRoot = await createEnvironmentFixture();
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const close = vi.fn(async () => {});
    const handle = { shutdown: vi.fn(async () => {}) };
    const evaluation = makeEvaluation("local");

    trackActiveSandboxHandle({ backendName: "microsandbox", handle, sessionKey: "session-1" });
    process.chdir(fixtureRoot);
    mockedEvalDependencies.createDevelopmentServer.mockReturnValue({
      close,
      start: vi.fn(async () => ({
        appRoot: fixtureRoot,
        kind: "started" as const,
        url: "http://127.0.0.1:43123",
      })),
    });
    mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue([evaluation]);
    mockedEvalDependencies.discoverEvalConfig.mockResolvedValue(TEST_CONFIG);
    mockedEvalDependencies.resolveEvalTargetHandle.mockResolvedValue({
      attachSession: vi.fn(),
      capabilities: { devRoutes: true },
      dispatchSchedule: vi.fn(),
      fetch: vi.fn(),
      kind: "local",
      url: "http://127.0.0.1:43123",
    });
    mockedEvalDependencies.executeEval.mockResolvedValue(makeEvalResult(evaluation.id));

    try {
      await runCli(["eval"], logger);
    } finally {
      process.chdir(previousCwd);
    }

    expect(close).toHaveBeenCalledTimes(1);
    expect(handle.shutdown).toHaveBeenCalledTimes(1);
    expect(process.env.EVE_EVALUATION).toBe("1");
    expect(process.env.EVE_EVALUATION_RUN_ID).toMatch(/^[0-9a-f-]{36}$/u);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("writes all evals to one JUnit file", async () => {
    const fixtureRoot = await createEnvironmentFixture();
    const previousCwd = process.cwd();
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
    };
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const target = {
      attachSession: vi.fn(),
      capabilities: { devRoutes: false },
      dispatchSchedule: vi.fn(),
      fetch: vi.fn(),
      kind: "remote" as const,
      url: "https://example.com",
    };

    process.chdir(fixtureRoot);
    mockedEvalDependencies.discoverAndImportEvals.mockResolvedValue([
      makeEvaluation("alpha"),
      makeEvaluation("beta"),
    ]);
    mockedEvalDependencies.discoverEvalConfig.mockResolvedValue(TEST_CONFIG);
    mockedEvalDependencies.resolveEvalTargetHandle.mockResolvedValue(target);
    mockedEvalDependencies.executeEval.mockImplementation(async (input) =>
      makeEvalResult(input.evaluation.id),
    );

    try {
      await runCli(
        [
          "eval",
          "--url",
          "https://example.com",
          "--json",
          "--junit",
          join(fixtureRoot, "junit.xml"),
        ],
        logger,
      );
    } finally {
      process.chdir(previousCwd);
    }

    const xml = await readFile(join(fixtureRoot, "junit.xml"), "utf8");
    expect(xml).toContain('<testsuite name="eve evals" tests="2" failures="1" skipped="0"');
    expect(xml).toContain('name="alpha"');
    expect(xml).toContain('name="beta"');
    expect(xml).toContain('<failure message="check (0% &lt; 100%): nope">');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

function makeEvaluation(id: string) {
  return {
    _tag: "EveEval" as const,
    id,
    test: async () => {},
  };
}

function makeEvalResult(id: string) {
  const failed = id === "beta";
  return {
    id,
    assertions: [
      failed
        ? { name: "check", score: 0, severity: "gate" as const, passed: false, message: "nope" }
        : { name: "check", score: 1, severity: "gate" as const, passed: true },
    ],
    result: {
      derived: {
        failureCode: undefined,
        inputRequests: [],
        messageCount: 1,
        parked: false,
        reasoningBlockCount: 0,
        subagentCallCount: 0,
        subagentCalls: [],
        toolCallCount: 0,
        toolCalls: [],
      },
      events: [],
      finalMessage: "done",
      output: "done",
      status: "completed",
    },
    verdict: failed ? "failed" : "passed",
    startedAt: "2026-04-08T00:00:00.000Z",
    completedAt: "2026-04-08T00:00:01.000Z",
  };
}
