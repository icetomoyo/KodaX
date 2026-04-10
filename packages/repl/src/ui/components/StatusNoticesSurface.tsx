import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";

export interface StatusNoticesSurfaceProps {
  notices: readonly string[];
}

export const StatusNoticesSurface: React.FC<StatusNoticesSurfaceProps> = ({
  notices,
}) => {
  const visibleNotices = notices.filter((notice) => notice.trim().length > 0);
  if (visibleNotices.length === 0) {
    return null;
  }

  const theme = getTheme("dark");

  return (
    <Box flexDirection="column" paddingX={1}>
      {visibleNotices.map((notice, index) => (
        <Text key={`${notice}-${index}`} color={theme.colors.dim}>
          {notice}
        </Text>
      ))}
    </Box>
  );
};

