import React from "react";
import { Box, Text } from "ink";
import type { KodaXAmaFanoutClass } from "@kodax/coding";
import { getTheme } from "../themes/index.js";

export function formatAmaWorkStripText(
  fanoutClass?: KodaXAmaFanoutClass,
  count?: number,
): string | undefined {
  if (!fanoutClass || !count || count <= 0) {
    return undefined;
  }

  switch (fanoutClass) {
    case "finding-validation":
      return `Validating ${count} finding${count === 1 ? "" : "s"}`;
    case "module-triage":
      return `Scanning ${count} module${count === 1 ? "" : "s"}`;
    case "evidence-scan":
      return `Parallel evidence pass (${count})`;
    case "hypothesis-check":
      return `Checking ${count} hypothesis${count === 1 ? "" : "es"}`;
    default:
      return undefined;
  }
}

export interface AmaWorkStripProps {
  text?: string;
}

export const AmaWorkStrip: React.FC<AmaWorkStripProps> = ({ text }) => {
  const theme = getTheme("dark");

  if (!text) {
    return null;
  }

  return (
    <Box>
      <Text color={theme.colors.primary} dimColor>
        {text}
      </Text>
    </Box>
  );
};
