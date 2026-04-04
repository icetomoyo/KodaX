import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

export interface NotificationSurfaceItem {
  id: string;
  text: string;
  tone?: "info" | "warning" | "accent";
}

export interface NotificationsSurfaceProps {
  notifications: readonly NotificationSurfaceItem[];
}

function resolveNotificationColor(
  tone: NotificationSurfaceItem["tone"] | undefined,
  colors: ReturnType<typeof getTheme>["colors"],
): string {
  switch (tone) {
    case "warning":
      return colors.warning;
    case "accent":
      return colors.accent;
    case "info":
    default:
      return colors.dim;
  }
}

export const NotificationsSurface: React.FC<NotificationsSurfaceProps> = ({
  notifications,
}) => {
  const visibleNotifications = notifications.filter(
    (notification) => notification.text.trim().length > 0,
  );
  const theme = getTheme("dark");
  if (visibleNotifications.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {visibleNotifications.map((notification) => (
        <Text
          key={notification.id}
          color={resolveNotificationColor(notification.tone, theme.colors)}
        >
          {notification.text}
        </Text>
      ))}
    </Box>
  );
};
