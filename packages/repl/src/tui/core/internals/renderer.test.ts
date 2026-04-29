import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- vendored .js file with no .d.ts
import renderer from "./renderer.js";

/**
 * Engine-side mirror of `substrate/ink/renderer.test.ts`. Both renderers
 * import the same `outputToScreen` from `substrate/ink/`; structural parity
 * is verified across both files. Phase 6 (v0.7.30): cell renderer is the
 * sole render path on both mirrors.
 */
function fakeRootNode(width: number, height: number): object {
  return {
    yogaNode: {
      getComputedWidth: () => width,
      getComputedHeight: () => height,
      getDisplay: () => 0, // DISPLAY_FLEX
      getComputedLeft: () => 0,
      getComputedTop: () => 0,
      getComputedBorder: () => 0,
    },
    nodeName: "ink-root",
    childNodes: [],
    style: { flexDirection: "column" },
    staticNode: undefined,
    internal_static: false,
    internal_accessibility: undefined,
    internal_transform: undefined,
    attributes: {},
  };
}

describe("core/internals/renderer (FEATURE_057 Track F, Phase 6: cell renderer is sole render path — engine-side mirror)", () => {
  describe("non-screen-reader path: frame populated unconditionally", () => {
    it("empty 5x1 root: frame has the right dimensions, cursor lands at content bottom", () => {
      const node = fakeRootNode(5, 1);
      const result = renderer(node, false);
      expect(result.frame).toBeDefined();
      const frame = result.frame!;
      expect(frame.screen.width).toBe(5);
      expect(frame.screen.height).toBe(1);
      expect(frame.cursor).toEqual({ x: 0, y: 1, visible: true });
    });

    it("viewport defaults to yoga-computed content size when terminalSize not supplied", () => {
      const node = fakeRootNode(10, 4);
      const result = renderer(node, false);
      expect(result.frame!.viewport).toEqual({ width: 10, height: 4 });
    });

    it("terminalSize override: frame.viewport tracks terminal dims, not content dims", () => {
      const node = fakeRootNode(3, 1);
      const result = renderer(node, false, { rows: 24, columns: 80 });
      expect(result.frame!.screen.width).toBe(3);
      expect(result.frame!.screen.height).toBe(1);
      expect(result.frame!.viewport).toEqual({ width: 80, height: 24 });
    });

    it("renders a node with no yogaNode → empty fallback shape (frame undefined regardless of context)", () => {
      const result = renderer({ yogaNode: undefined } as unknown as object, false);
      expect(result).toEqual({
        output: "",
        outputHeight: 0,
        staticOutput: "",
        frame: undefined,
      });
    });
  });

  describe("screen-reader path: returns frame undefined", () => {
    it("screen-reader path skips Frame production", () => {
      const node = fakeRootNode(3, 1);
      const result = renderer(node, true);
      expect(result.frame).toBeUndefined();
    });
  });

  describe("legacy fields populated regardless of cell renderer", () => {
    it("output / outputHeight / staticOutput populated alongside frame", () => {
      const node = fakeRootNode(3, 1);
      const result = renderer(node, false);
      expect(result.output).toBe("");
      expect(result.outputHeight).toBe(1);
      expect(result.staticOutput).toBe("");
    });
  });
});
