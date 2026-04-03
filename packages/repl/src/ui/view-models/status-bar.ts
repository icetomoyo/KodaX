import type { StatusBarProps } from "../types.js";
import { getStatusBarText } from "../components/StatusBar.js";

export interface StatusBarViewModel {
  text: string;
}

export function buildStatusBarViewModel(
  props: StatusBarProps,
): StatusBarViewModel {
  return {
    text: getStatusBarText(props),
  };
}
