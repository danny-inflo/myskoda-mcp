import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

// Muted olive/sage, independently chosen for Vehicle Connect. No Škoda brand palette.
export const vehicleConnectTheme = defineTheme({
  name: "vehicle-connect",
  extends: neutralTheme,
  typography: { body: { family: "system-ui" }, heading: { family: "system-ui" } },
  tokens: {
    "--font-family-body": "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "--font-family-heading": "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "--color-background-body": ["#F5F6F1", "#1D231E"],
    "--color-background-surface": ["#FFFFFF", "#262D27"],
    "--color-background-card": ["#FFFFFF", "#262D27"],
    "--color-background-muted": ["#ECEFE5", "#303A2F"],
    "--color-background-popover": ["#FFFFFF", "#262D27"],
    "--color-accent": ["#5F7155", "#B3C4A0"],
    "--color-accent-muted": ["#E9EDDF", "#34402E"],
  },
  components: { center: { base: { backgroundColor: "var(--color-background-body)" } } },
  adaptations: { rules: [
    { when: { width: { below: "sm" } }, value: { tokens: { "--spacing-8": "24px" } } },
    { when: { pointer: "coarse" }, value: { tokens: { "--size-element-lg": "44px" } } },
  ] },
});
