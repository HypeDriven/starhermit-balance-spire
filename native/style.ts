// The look of the menus and HUD: the browser build's style sheet, rewritten
// class-based in tools/ui-style.css and converted once with `starhermit css`
// into assets/ui-style.json (`npm run css`), registered at start with the
// theme the runtime's own widgets (checkboxes, scroll bars) fall back to.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export const COLORS = {
  ink: "#f0ece4", dim: "#b6b0a6", bg: "#14101e", panel: "#181424eb", line: "#3a3450",
  accent: "#ffd9a0", accent2: "#9fc8ff", danger: "#e86a5a", focus: "#fff2cc", hover: "#2a2440",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 12,
    text: COLORS.ink, muted: COLORS.dim, panel: "#181424", control: "#181424", hovered: COLORS.hover,
    pressed: COLORS.hover, field: "#1f1a2e", accent: COLORS.accent, focus: COLORS.focus, outline: COLORS.line,
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 36,
      parts: { box: { background: "#1f1a2e", border: { width: 1, color: "$line" }, radius: 4 }, mark: { background: "$accent" } },
    },
    scrollArea: { parts: { bar: { background: "$line", radius: 4 } } },
  });
}
