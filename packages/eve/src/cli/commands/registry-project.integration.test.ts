import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  prepareWebChatProjectRoot,
  prepareWebRegistryProject,
  readRegistryConfig,
} from "./registry-project.js";

describe("registry project configuration", () => {
  it("reads registry mappings from an agent workspace package", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-workspace-"));
    const agentRoot = join(workspaceRoot, "agents", "support");
    await mkdir(join(agentRoot, "agent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        dependencies: { eve: "*" },
        registries: { "@acme": "https://example.com/r/{name}.json" },
      }),
    );

    await expect(readRegistryConfig(agentRoot)).resolves.toEqual({
      registries: { "@acme": "https://example.com/r/{name}.json" },
    });
  });

  it("prepares Web Chat in the environment root without creating a nested package", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-web-workspace-"));
    const agentRoot = join(workspaceRoot, "agents", "support");
    const webRoot = join(workspaceRoot, "apps", "web");
    await mkdir(join(agentRoot, "agent"), { recursive: true });
    await mkdir(webRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ scripts: { dev: "eve dev" }, dependencies: { eve: "*" } }, null, 2)}\n`,
    );
    await writeFile(join(webRoot, "tsconfig.json"), "{}\n");

    await expect(prepareWebChatProjectRoot(agentRoot)).resolves.toBe(workspaceRoot);
    await prepareWebRegistryProject(workspaceRoot);

    const packageJson = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const tsconfig = JSON.parse(await readFile(join(webRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(packageJson.scripts).toMatchObject({
      dev: "eve dev",
      "dev:web": "cd apps/web && next dev",
      "build:web": "cd apps/web && next build",
    });
    expect(tsconfig.compilerOptions.paths["@/*"]).toEqual(["./*"]);
    await expect(readFile(join(webRoot, "package.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
