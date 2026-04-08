import { createContext } from "react";

export interface AccessibilityContextValue {
  isScreenReaderEnabled: boolean;
}

export const accessibilityContext = createContext<AccessibilityContextValue>({
  isScreenReaderEnabled: false,
});
