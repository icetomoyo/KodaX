import React, { forwardRef, useContext } from "react";
import { accessibilityContext } from "../contexts/AccessibilityContext.js";
import { backgroundContext } from "../contexts/BackgroundContext.js";

type BoxStyle = Record<string, any> & {
  backgroundColor?: string;
  overflowX?: string;
  overflowY?: string;
  overflow?: string;
};

interface BoxProps extends React.PropsWithChildren<BoxStyle> {
  backgroundColor?: string;
  "aria-label"?: string;
  "aria-hidden"?: boolean;
  "aria-role"?: string;
  "aria-state"?: Record<string, unknown>;
}

const Box = forwardRef<unknown, BoxProps>(({
  children,
  backgroundColor,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
  "aria-role": role,
  "aria-state": ariaState,
  ...style
}, ref) => {
  const { isScreenReaderEnabled } = useContext(accessibilityContext);
  const label = ariaLabel
    ? React.createElement("ink-text", null, ariaLabel as React.ReactNode)
    : undefined;

  if (isScreenReaderEnabled && ariaHidden) {
    return null;
  }

  const boxElement = React.createElement(
    "ink-box",
    {
      ref,
      style: {
        flexWrap: "nowrap",
        flexDirection: "row",
        flexGrow: 0,
        flexShrink: 1,
        ...style,
        backgroundColor,
        overflowX: style.overflowX ?? style.overflow ?? "visible",
        overflowY: style.overflowY ?? style.overflow ?? "visible",
      },
      internal_accessibility: {
        role,
        state: ariaState,
      },
    },
    isScreenReaderEnabled && label ? label : (children as React.ReactNode),
  );

  if (backgroundColor) {
    return React.createElement(
      backgroundContext.Provider,
      { value: backgroundColor as string },
      boxElement,
    );
  }

  return boxElement;
});

Box.displayName = "Box";

export default Box;
