import React, { useContext } from "react";
import chalk from "chalk";
import colorize from "../colorize.js";
import { accessibilityContext } from "../contexts/AccessibilityContext.js";
import { backgroundContext } from "../contexts/BackgroundContext.js";

interface TextProps extends React.PropsWithChildren {
  color?: string;
  backgroundColor?: string;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  wrap?: "wrap" | "truncate" | "truncate-middle";
  "aria-label"?: string;
  "aria-hidden"?: boolean;
}

export default function Text({
  color,
  backgroundColor,
  dimColor = false,
  bold = false,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = "wrap",
  children,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden = false,
}: TextProps) {
  const { isScreenReaderEnabled } = useContext(accessibilityContext);
  const inheritedBackgroundColor = useContext(backgroundContext);
  const childrenOrAriaLabel = isScreenReaderEnabled && ariaLabel ? ariaLabel : children;

  if (childrenOrAriaLabel === undefined || childrenOrAriaLabel === null) {
    return null;
  }

  const transform = (content: string) => {
    let transformed = content;

    if (dimColor) {
      transformed = chalk.dim(transformed);
    }
    if (color) {
      transformed = colorize(transformed, color, "foreground");
    }

    const effectiveBackgroundColor = backgroundColor ?? inheritedBackgroundColor;
    if (effectiveBackgroundColor) {
      transformed = colorize(transformed, effectiveBackgroundColor, "background");
    }
    if (bold) {
      transformed = chalk.bold(transformed);
    }
    if (italic) {
      transformed = chalk.italic(transformed);
    }
    if (underline) {
      transformed = chalk.underline(transformed);
    }
    if (strikethrough) {
      transformed = chalk.strikethrough(transformed);
    }
    if (inverse) {
      transformed = chalk.inverse(transformed);
    }

    return transformed;
  };

  if (isScreenReaderEnabled && ariaHidden) {
    return null;
  }

  return React.createElement(
    "ink-text",
    {
      style: { flexGrow: 0, flexShrink: 1, flexDirection: "row", textWrap: wrap },
      internal_transform: transform,
    },
    isScreenReaderEnabled && ariaLabel ? ariaLabel : children,
  );
}
