// Localization: the engine's string tables (assets/strings.json, the nine
// StarHermit locales) in the interface language the runtime reports (the
// player's choice in Options › Language, else the account's preferred
// language or the device's); the engine's fallback chain picks the table.
// The account lines are the engine's own `starhermit.*` strings.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

type Vars = Record<string, string | number>;
/** A game string by key in the player's language; `{name}` placeholders from vars. */
export function t(key: string, vars?: Vars | null, fallback?: string): string {
  if (fallback !== undefined && !strings.has(key)) return fallback;
  return strings.t(key, vars ?? undefined);
}
