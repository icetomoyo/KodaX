import type { ReactNode } from "react";
import VendoredInk from "../substrate/ink/ink.js";

interface VendoredInkInstance extends InstanceType<typeof VendoredInk> {
  setAltScreenActive?: (active: boolean, mouseTracking?: boolean) => void;
  clearTextSelection?: () => void;
}

export type RendererOptions = ConstructorParameters<typeof VendoredInk>[0];

export interface RendererInstanceHandle {
  readonly isConcurrent: boolean;
  render: (node: ReactNode) => void;
  unmount: (error?: unknown) => void;
  waitUntilExit: () => Promise<unknown>;
  clear: () => void;
  setAltScreenActive?: (active: boolean, mouseTracking?: boolean) => void;
  clearTextSelection?: () => void;
}

export default class KodaXRenderer implements RendererInstanceHandle {
  private readonly vendoredInstance: VendoredInkInstance;

  readonly isConcurrent: boolean;

  constructor(options: RendererOptions) {
    this.vendoredInstance = new VendoredInk(options) as VendoredInkInstance;
    this.isConcurrent = this.vendoredInstance.isConcurrent;
  }

  render = (node: ReactNode) => {
    this.vendoredInstance.render(node);
  };

  unmount = (error?: unknown) => {
    this.vendoredInstance.unmount(error);
  };

  waitUntilExit = () => this.vendoredInstance.waitUntilExit();

  clear = () => {
    this.vendoredInstance.clear();
  };

  setAltScreenActive = (active: boolean, mouseTracking?: boolean) => {
    this.vendoredInstance.setAltScreenActive?.(active, mouseTracking);
  };

  clearTextSelection = () => {
    this.vendoredInstance.clearTextSelection?.();
  };
}
