import { afterEach, describe, expect, it } from "vitest";
import { t, setLocale, getLocale } from "./i18n.js";

describe("i18n", () => {
  afterEach(() => {
    setLocale("en");
  });

  it("defaults to English", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("dialog.confirm")).toBe("[Confirm]");
  });

  it("switches to Chinese", () => {
    setLocale("zh");
    expect(getLocale()).toBe("zh");
    expect(t("dialog.confirm")).toBe("[确认]");
    expect(t("confirm.instruction.basic")).toBe("按 (y) 确认, (n) 拒绝");
  });

  it("handles zh-CN and zh-cn variants", () => {
    setLocale("zh-CN");
    expect(getLocale()).toBe("zh");

    setLocale("zh-cn");
    expect(getLocale()).toBe("zh");
  });

  it("falls back to English for unknown locales", () => {
    setLocale("fr");
    expect(getLocale()).toBe("en");

    setLocale("ja");
    expect(getLocale()).toBe("en");
  });

  it("interpolates variables", () => {
    setLocale("en");
    expect(t("tool.generic.title", { tool: "mcp_search" })).toBe("Execute mcp_search?");

    setLocale("zh");
    expect(t("tool.generic.title", { tool: "mcp_search" })).toBe("执行 mcp_search？");
  });

  it("returns key as fallback for unknown keys", () => {
    expect(t("nonexistent.key" as Parameters<typeof t>[0])).toBe("nonexistent.key");
  });
});
