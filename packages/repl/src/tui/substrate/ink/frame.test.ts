import { describe, it, expect } from "vitest";
import { createScreen } from "./cell-screen.js";
import { emptyFrame, shouldClearScreen, type Frame } from "./frame.js";

function makeFrame(opts: {
  screenW: number;
  screenH: number;
  viewW: number;
  viewH: number;
  cursor?: { x: number; y: number; visible: boolean };
}): Frame {
  return {
    screen: createScreen(opts.screenW, opts.screenH),
    viewport: { width: opts.viewW, height: opts.viewH },
    cursor: opts.cursor ?? { x: 0, y: 0, visible: true },
  };
}

describe("substrate/ink/frame (FEATURE_057 Track F Phase 1)", () => {
  describe("emptyFrame", () => {
    it("seeds an empty 0x0 screen with the requested viewport", () => {
      const f = emptyFrame(24, 80);
      expect(f.viewport).toEqual({ width: 80, height: 24 });
      expect(f.screen.width).toBe(0);
      expect(f.screen.height).toBe(0);
      expect(f.cursor).toEqual({ x: 0, y: 0, visible: true });
    });
  });

  describe("shouldClearScreen", () => {
    it("returns 'resize' when viewport width changes", () => {
      const prev = makeFrame({ screenW: 5, screenH: 5, viewW: 80, viewH: 24 });
      const next = makeFrame({ screenW: 5, screenH: 5, viewW: 81, viewH: 24 });
      expect(shouldClearScreen(prev, next)).toBe("resize");
    });

    it("returns 'resize' when viewport height changes", () => {
      const prev = makeFrame({ screenW: 5, screenH: 5, viewW: 80, viewH: 24 });
      const next = makeFrame({ screenW: 5, screenH: 5, viewW: 80, viewH: 25 });
      expect(shouldClearScreen(prev, next)).toBe("resize");
    });

    it("returns 'offscreen' when current frame screen height >= viewport height", () => {
      const prev = makeFrame({ screenW: 80, screenH: 5, viewW: 80, viewH: 24 });
      const next = makeFrame({ screenW: 80, screenH: 24, viewW: 80, viewH: 24 });
      expect(shouldClearScreen(prev, next)).toBe("offscreen");
    });

    it("returns 'offscreen' when previous frame screen height >= viewport height", () => {
      const prev = makeFrame({ screenW: 80, screenH: 24, viewW: 80, viewH: 24 });
      const next = makeFrame({ screenW: 80, screenH: 5, viewW: 80, viewH: 24 });
      expect(shouldClearScreen(prev, next)).toBe("offscreen");
    });

    it("returns undefined when viewport unchanged and both screens fit inside", () => {
      const prev = makeFrame({ screenW: 80, screenH: 5, viewW: 80, viewH: 24 });
      const next = makeFrame({ screenW: 80, screenH: 6, viewW: 80, viewH: 24 });
      expect(shouldClearScreen(prev, next)).toBeUndefined();
    });
  });
});
