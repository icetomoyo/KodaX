import { describe, it, expect } from "vitest";
import { LINK_END, link } from "./osc.js";

describe("substrate/ink/osc (FEATURE_057 Track F Phase 1)", () => {
  it("returns LINK_END when url is empty (link close)", () => {
    expect(link("")).toBe(LINK_END);
  });

  it("LINK_END is OSC 8 with empty params + empty URL", () => {
    expect(LINK_END).toBe("\x1b]8;;\x07");
  });

  it("link() emits OSC 8 with auto-generated id and the URL", () => {
    const result = link("https://example.com/page");
    expect(result.startsWith("\x1b]8;id=")).toBe(true);
    expect(result.endsWith(";https://example.com/page\x07")).toBe(true);
  });

  it("link() id is deterministic for the same URL", () => {
    expect(link("https://a.example/")).toBe(link("https://a.example/"));
  });

  it("link() id differs for different URLs", () => {
    const a = link("https://a.example/");
    const b = link("https://b.example/");
    expect(a).not.toBe(b);
  });

  it("link() merges user params (user keys win on collision since spread is left-to-right)", () => {
    // Implementation behavior: { id: auto, ...userParams } — userParams override id.
    const result = link("https://example.com", { id: "custom-id", title: "hi" });
    expect(result).toContain("id=custom-id");
    expect(result).toContain("title=hi");
  });
});
