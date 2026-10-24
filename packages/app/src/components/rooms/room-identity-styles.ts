import { StyleSheet } from "react-native-unistyles";
import type { TextStyle } from "react-native";
import {
  identityColor,
  identityForeground,
  IDENTITY_COLOR_NAMES,
  type IdentityColorName,
} from "@/styles/identity-colors";

/**
 * Room identity styles (design §4.1): member names in the identity foreground
 * table, avatars on the identity fill. One themed stylesheet shared by the
 * seats, the transcript feed and the files drawer so the three can't drift.
 * Foreground colors live here (not `uniProps`, which omits `style`) so the
 * Babel plugin tracks `colorScheme` and repaints on theme switches.
 */
export const roomIdentityStyles = StyleSheet.create((theme) => ({
  nameViolet: { color: identityForeground("violet", theme.colorScheme) },
  nameSky: { color: identityForeground("sky", theme.colorScheme) },
  nameEmerald: { color: identityForeground("emerald", theme.colorScheme) },
  nameOrange: { color: identityForeground("orange", theme.colorScheme) },
  namePink: { color: identityForeground("pink", theme.colorScheme) },
  nameIndigo: { color: identityForeground("indigo", theme.colorScheme) },
  nameTeal: { color: identityForeground("teal", theme.colorScheme) },
  nameRed: { color: identityForeground("red", theme.colorScheme) },
  nameAmber: { color: identityForeground("amber", theme.colorScheme) },
  nameBlue: { color: identityForeground("blue", theme.colorScheme) },
}));

const NAME_STYLE_KEYS: Record<IdentityColorName, keyof typeof roomIdentityStyles> = {
  violet: "nameViolet",
  sky: "nameSky",
  emerald: "nameEmerald",
  orange: "nameOrange",
  pink: "namePink",
  indigo: "nameIndigo",
  teal: "nameTeal",
  red: "nameRed",
  amber: "nameAmber",
  blue: "nameBlue",
};

/** Themed foreground style for a member's display name. */
export function roomNameStyle(name: IdentityColorName): TextStyle {
  // The proxy union carries Unistyles' internal variants hook; the style value
  // itself is exactly what the factory produced.
  return roomIdentityStyles[NAME_STYLE_KEYS[name]] as TextStyle;
}

// Avatar fills come straight from the identity table — scheme-independent
// static values, so they live outside any theme factory.
export const ROOM_AVATAR_FILL: Record<IdentityColorName, { backgroundColor: string }> = (() => {
  const byName = {} as Record<IdentityColorName, { backgroundColor: string }>;
  for (const name of IDENTITY_COLOR_NAMES) {
    byName[name] = { backgroundColor: identityColor(name) };
  }
  return byName;
})();
