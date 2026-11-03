import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IntegrationConfigController,
  IntegrationConfigConflictError,
  migrateLegacyIntegrationConfig,
  planLegacyIntegrationMigration,
  parseExtensionsIntegrationDocument,
  parseMcpIntegrationDocument,
  readExtensionsIntegration,
  readMcpIntegration,
  resolveIntegrationConfigPath,
  writeIntegrationDocument,
} from "./integration-config.js";
import { CoreConfigWriteConflictError } from "./core-config-lock.js";

let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(path.join(tmpdir(), "kodax-integrations-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(configHome, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("FEATURE_268 integration config substrate", () => {
  it("recovers a verified dead integration writer without changing the legacy lock pathname", () => {
    const file = resolveIntegrationConfigPath('mcp', configHome);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, JSON.stringify({ version: 1, pid: 2_146_999_999, nonce: 'integration-fixture' }));
    const result = writeIntegrationDocument({ domain: 'mcp', configHome, document: { version: 1, servers: {} }, validate: parseMcpIntegrationDocument, expectedRevision: null });
    expect(result.source).toBe('user');
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
  it("uses exactly one user file per integration domain", () => {
    expect(resolveIntegrationConfigPath("mcp", configHome)).toBe(
      path.join(configHome, "integrations", "mcp.json"),
    );
    expect(resolveIntegrationConfigPath("a2a", configHome)).toBe(
      path.join(configHome, "integrations", "a2a.json"),
    );
    expect(resolveIntegrationConfigPath("extensions", configHome)).toBe(
      path.join(configHome, "integrations", "extensions.json"),
    );
  });

  it("strictly validates versioned MCP and Extension documents", () => {
    expect(
      parseMcpIntegrationDocument({
        version: 1,
        servers: { local: { command: "node", args: ["server.mjs"] } },
      }).servers.local?.command,
    ).toBe("node");
    expect(() =>
      parseMcpIntegrationDocument({
        version: 1,
        servers: {},
        extra: true,
      }),
    ).toThrow(/unknown.*extra/i);
    expect(() =>
      parseMcpIntegrationDocument({ version: 2, servers: {} }),
    ).toThrow(/version/i);

    expect(
      parseExtensionsIntegrationDocument({
        version: 1,
        paths: ["~/.kodax/extensions/reporting"],
      }).paths,
    ).toEqual(["~/.kodax/extensions/reporting"]);
    expect(() =>
      parseExtensionsIntegrationDocument({
        version: 1,
        paths: ["ok", ""],
      }),
    ).toThrow(/paths/i);
  });

  it("reads legacy core declarations only while the domain file is absent", () => {
    const core = path.join(configHome, "config.json");
    writeJson(core, {
      provider: "anthropic",
      mcpServers: { legacy: { command: "legacy-server" } },
      extensions: ["legacy-extension.mjs"],
    });

    expect(readMcpIntegration(configHome)).toMatchObject({
      source: "legacy-user",
      path: core,
      document: {
        version: 1,
        servers: { legacy: { command: "legacy-server" } },
      },
    });
    expect(readExtensionsIntegration(configHome)).toMatchObject({
      source: "legacy-user",
      path: core,
      document: { version: 1, paths: ["legacy-extension.mjs"] },
    });

    writeIntegrationDocument({
      domain: "mcp",
      configHome,
      document: {
        version: 1,
        servers: { current: { command: "current-server" } },
      },
      validate: parseMcpIntegrationDocument,
    });
    expect(readMcpIntegration(configHome)).toMatchObject({
      source: "user",
      document: {
        version: 1,
        servers: { current: { command: "current-server" } },
      },
    });
  });

  it("atomically writes one domain without rewriting core config or sibling domains", () => {
    const core = path.join(configHome, "config.json");
    const extensions = resolveIntegrationConfigPath("extensions", configHome);
    writeJson(core, { provider: "deepseek" });
    writeJson(extensions, { version: 1, paths: ["keep.mjs"] });
    const coreBefore = readFileSync(core, "utf8");
    const extensionsBefore = readFileSync(extensions, "utf8");

    const written = writeIntegrationDocument({
      domain: "mcp",
      configHome,
      document: { version: 1, servers: { local: { command: "node" } } },
      validate: parseMcpIntegrationDocument,
    });

    expect(written.source).toBe("user");
    expect(existsSync(resolveIntegrationConfigPath("mcp", configHome))).toBe(
      true,
    );
    expect(readFileSync(core, "utf8")).toBe(coreBefore);
    expect(readFileSync(extensions, "utf8")).toBe(extensionsBefore);
  });

  it("rejects stale expected revisions instead of silently overwriting", () => {
    const first = writeIntegrationDocument({
      domain: "mcp",
      configHome,
      document: { version: 1, servers: {} },
      validate: parseMcpIntegrationDocument,
    });
    writeIntegrationDocument({
      domain: "mcp",
      configHome,
      expectedRevision: first.revision,
      document: { version: 1, servers: { newer: { command: "newer" } } },
      validate: parseMcpIntegrationDocument,
    });

    expect(() =>
      writeIntegrationDocument({
        domain: "mcp",
        configHome,
        expectedRevision: first.revision,
        document: { version: 1, servers: { stale: { command: "stale" } } },
        validate: parseMcpIntegrationDocument,
      }),
    ).toThrow(/revision.*changed/i);
  });

  it("supports create-only writes so a stale migration plan cannot replace a new file", () => {
    const file = resolveIntegrationConfigPath("mcp", configHome);
    writeJson(file, {
      version: 1,
      servers: { concurrent: { command: "keep-me" } },
    });

    expect(() =>
      writeIntegrationDocument({
        domain: "mcp",
        configHome,
        expectedRevision: null,
        document: {
          version: 1,
          servers: { legacy: { command: "do-not-write" } },
        },
        validate: parseMcpIntegrationDocument,
      }),
    ).toThrow(IntegrationConfigConflictError);
    expect(readMcpIntegration(configHome).document.servers).toEqual({
      concurrent: { command: "keep-me" },
    });
  });

  it("watches the legacy core dependency and recovers after an invalid cold start", async () => {
    const core = path.join(configHome, "config.json");
    writeJson(core, {
      mcpServers: { legacy: { command: 42 } },
    });
    const controller = new IntegrationConfigController({
      domain: "mcp",
      configHome,
      validate: parseMcpIntegrationDocument,
      read: () => readMcpIntegration(configHome),
      fallbackPath: core,
      coldStartDefault: { version: 1, servers: {} },
    });

    const initial = await controller.initialize();
    expect(initial).toMatchObject({
      source: "default",
      document: { version: 1, servers: {} },
    });
    expect(controller.status()).toMatchObject({
      path: core,
      source: "legacy-user",
      diagnostic: { code: "invalid-config" },
    });

    controller.startWatching(10_000, 20);
    try {
      writeJson(core, {
        mcpServers: { repaired: { command: "node", args: ["server.mjs"] } },
      });
      await vi.waitFor(
        () => {
          expect(controller.snapshot()).toMatchObject({
            path: core,
            source: "legacy-user",
            document: { servers: { repaired: { command: "node" } } },
          });
          expect(controller.status().diagnostic).toBeUndefined();
        },
        { timeout: 2_000 },
      );
    } finally {
      controller.close();
    }
  });

  it("keeps last-known-good state after an invalid reload and recovers later", async () => {
    const file = resolveIntegrationConfigPath("extensions", configHome);
    writeJson(file, { version: 1, paths: ["one.mjs"] });
    const controller = new IntegrationConfigController({
      domain: "extensions",
      configHome,
      validate: parseExtensionsIntegrationDocument,
      read: () => readExtensionsIntegration(configHome),
    });

    await controller.initialize();
    expect(controller.snapshot()?.document.paths).toEqual(["one.mjs"]);

    writeFileSync(file, "{ broken", "utf8");
    const rejected = await controller.reload();
    expect(rejected.ok).toBe(false);
    expect(controller.snapshot()?.document.paths).toEqual(["one.mjs"]);
    expect(controller.status().diagnostic?.message).not.toContain("{ broken");

    writeJson(file, { version: 1, paths: ["two.mjs"] });
    await expect(controller.ensureCurrent()).resolves.toMatchObject({
      ok: true,
    });
    expect(controller.snapshot()?.document.paths).toEqual(["two.mjs"]);
    controller.close();
  });

  it("uses an explicit safe default on an invalid cold start and recovers independently", async () => {
    const file = resolveIntegrationConfigPath("mcp", configHome);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ broken", "utf8");
    const controller = new IntegrationConfigController({
      domain: "mcp",
      configHome,
      validate: parseMcpIntegrationDocument,
      read: () => readMcpIntegration(configHome),
      coldStartDefault: { version: 1, servers: {} },
    });

    const initial = await controller.initialize();
    expect(initial).toMatchObject({
      domain: "mcp",
      source: "default",
      document: { version: 1, servers: {} },
    });
    expect(controller.status()).toMatchObject({
      domain: "mcp",
      source: "user",
      diagnostic: { code: "invalid-config" },
    });
    expect(controller.status().diagnostic?.message).not.toContain("{ broken");

    writeJson(file, {
      version: 1,
      servers: { repaired: { command: "node", args: ["server.mjs"] } },
    });
    await expect(controller.ensureCurrent()).resolves.toMatchObject({
      ok: true,
    });
    expect(controller.snapshot()).toMatchObject({
      source: "user",
      document: { servers: { repaired: { command: "node" } } },
    });
    expect(controller.status().diagnostic).toBeUndefined();
    controller.close();
  });

  it("still rejects an invalid cold start when no safe default is declared", async () => {
    const file = resolveIntegrationConfigPath("extensions", configHome);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ broken", "utf8");
    const controller = new IntegrationConfigController({
      domain: "extensions",
      configHome,
      validate: parseExtensionsIntegrationDocument,
      read: () => readExtensionsIntegration(configHome),
    });

    await expect(controller.initialize()).rejects.toThrow(/invalid/i);
    expect(controller.snapshot()).toBeUndefined();
    controller.close();
  });

  it("recovers a missed watch event through the metadata fallback", async () => {
    const controller = new IntegrationConfigController({
      domain: "extensions",
      configHome,
      validate: parseExtensionsIntegrationDocument,
      read: () => readExtensionsIntegration(configHome),
    });
    await controller.initialize();
    controller.startWatching(10_000, 20);
    try {
      writeIntegrationDocument({
        domain: "extensions",
        configHome,
        document: { version: 1, paths: ["fallback.mjs"] },
        validate: parseExtensionsIntegrationDocument,
      });
      await vi.waitFor(
        () => {
          expect(controller.snapshot()?.document.paths).toEqual([
            "fallback.mjs",
          ]);
        },
        { timeout: 2_000 },
      );
    } finally {
      controller.close();
    }
  });

  it("commits a watched candidate only after runtime subscribers accept it", async () => {
    const file = resolveIntegrationConfigPath("extensions", configHome);
    writeJson(file, { version: 1, paths: ["one.mjs"] });
    const controller = new IntegrationConfigController({
      domain: "extensions",
      configHome,
      validate: parseExtensionsIntegrationDocument,
      read: () => readExtensionsIntegration(configHome),
    });
    await controller.initialize();
    const apply = vi.fn(
      async (snapshot: ReturnType<typeof readExtensionsIntegration>) => {
        if (snapshot.document.paths.includes("broken.mjs")) {
          throw new Error(
            "candidate activation failed token=SECRET123 C:\\private\\extension.mjs",
          );
        }
      },
    );
    controller.subscribe(apply);

    writeJson(file, { version: 1, paths: ["broken.mjs"] });
    await expect(controller.reload()).resolves.toMatchObject({ ok: false });
    expect(controller.snapshot()?.document.paths).toEqual(["one.mjs"]);
    expect(controller.status().diagnostic).toMatchObject({
      code: "activation-failed",
    });
    expect(controller.status().diagnostic?.message).not.toContain("SECRET123");
    expect(controller.status().diagnostic?.message).not.toContain(
      "C:\\private",
    );

    writeJson(file, { version: 1, paths: ["two.mjs"] });
    await expect(controller.reload()).resolves.toMatchObject({ ok: true });
    expect(controller.snapshot()?.document.paths).toEqual(["two.mjs"]);
    expect(apply).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it("previews and applies legacy migration without overwriting domain files", () => {
    const core = path.join(configHome, "config.json");
    writeJson(core, {
      provider: "deepseek",
      mcpServers: { legacy: { command: "legacy-server" } },
      extensions: ["legacy-extension.mjs"],
    });

    expect(planLegacyIntegrationMigration(configHome)).toMatchObject({
      mcp: { action: "create", entries: 1 },
      extensions: { action: "create", entries: 1 },
    });
    const applied = migrateLegacyIntegrationConfig({
      configHome,
      cleanupLegacy: true,
    });
    expect(applied.applied).toEqual(["mcp", "extensions"]);
    expect(readMcpIntegration(configHome).source).toBe("user");
    expect(readExtensionsIntegration(configHome).source).toBe("user");
    expect(JSON.parse(readFileSync(core, "utf8"))).toEqual({
      provider: "deepseek",
    });

    writeJson(resolveIntegrationConfigPath("mcp", configHome), {
      version: 1,
      servers: { current: { command: "current-server" } },
    });
    expect(planLegacyIntegrationMigration(configHome).mcp.action).toBe("none");
  });

  it("flags literal secrets in legacy MCP server env and headers but not ${env:} references", () => {
    const core = path.join(configHome, "config.json");
    const planWarnings = (
      servers: Record<string, unknown>,
    ): readonly string[] => {
      writeJson(core, { mcpServers: servers });
      return planLegacyIntegrationMigration(configHome).warnings;
    };

    // ${env:...} references are not literal secrets -> no warning
    expect(
      planWarnings({ alpha: { command: "node", env: { token: "${env:TOKEN}" } } }),
    ).toEqual([]);
    expect(
      planWarnings({
        beta: { command: "node", headers: { authorization: "${env:KEY}" } },
      }),
    ).toEqual([]);

    // literal values on secret-named fields -> warning
    expect(
      planWarnings({ alpha: { command: "node", env: { token: "sk-xxx" } } }),
    ).toEqual([
      'MCP server "alpha" env.token may contain a literal secret.',
    ]);
    expect(
      planWarnings({
        beta: { command: "node", headers: { authorization: "Bearer xyz" } },
      }),
    ).toEqual([
      'MCP server "beta" headers.authorization may contain a literal secret.',
    ]);

    // non-secret field names are ignored even with a literal value
    expect(
      planWarnings({ gamma: { command: "node", env: { PATH: "/usr/bin" } } }),
    ).toEqual([]);

    // mixed env+headers: only the literal value is flagged, the reference is not
    expect(
      planWarnings({
        delta: {
          command: "node",
          env: { apiKey: "${env:API_KEY}" },
          headers: { authorization: "Bearer secret" },
        },
      }),
    ).toEqual([
      'MCP server "delta" headers.authorization may contain a literal secret.',
    ]);
  });

  it("preflights both legacy domains before writing either destination", () => {
    writeJson(path.join(configHome, "config.json"), {
      mcpServers: { legacy: { command: "legacy-server" } },
      extensions: ["duplicate.mjs", "duplicate.mjs"],
    });

    expect(() => migrateLegacyIntegrationConfig({ configHome })).toThrow(
      /must not contain duplicates/i,
    );
    expect(existsSync(resolveIntegrationConfigPath("mcp", configHome))).toBe(
      false,
    );
    expect(
      existsSync(resolveIntegrationConfigPath("extensions", configHome)),
    ).toBe(false);
  });

  it("uses the shared core lock for legacy reads and cleanup", () => {
    const core = path.join(configHome, "config.json");
    writeJson(core, {
      provider: "deepseek",
      mcpServers: { legacy: { command: "legacy-server" } },
    });
    writeFileSync(`${core}.write.lock`, "busy", "utf8");

    expect(() =>
      migrateLegacyIntegrationConfig({
        configHome,
        cleanupLegacy: true,
      }),
    ).toThrow(CoreConfigWriteConflictError);
    expect(JSON.parse(readFileSync(core, "utf8"))).toHaveProperty("mcpServers");
    expect(existsSync(resolveIntegrationConfigPath("mcp", configHome))).toBe(
      false,
    );
  });
});
