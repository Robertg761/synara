// FILE: fontFamily.ts
// Purpose: Convert user-entered font family names into valid CSS font-family values.
// Layer: Web appearance utilities
// Exports: font family normalization helpers

const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "revert", "revert-layer", "unset"]);

export const DEFAULT_MONOSPACE_FONT_FAMILY_STACK =
  '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

/**
 * Self-hosted variable faces register under a `"<Family> Variable"` name
 * (@fontsource-variable, see src/fonts.ts), while themes and users type the plain
 * family name ("Inter", "Geist"). Every known family is therefore expanded to
 * `"<Family> Variable", <Family>`: the bundled face wins, and a locally installed
 * copy of the plain family still resolves for anyone who has one.
 *
 * JetBrains Mono is deliberately absent — DEFAULT_MONOSPACE_FONT_FAMILY_STACK already
 * carries "JetBrains Mono Variable" and is appended to every code-font value.
 */
const SELF_HOSTED_VARIABLE_FONT_FAMILIES = new Map<string, string>([
  ["dm sans", "DM Sans Variable"],
  ["geist", "Geist Variable"],
  ["geist mono", "Geist Mono Variable"],
  ["inter", "Inter Variable"],
]);

const GENERIC_FONT_FAMILIES = new Set([
  "cursive",
  "emoji",
  "fangsong",
  "fantasy",
  "math",
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

function splitFontFamilyList(value: string): string[] {
  const families: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let parenDepth = 0;

  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "(") {
      parenDepth += 1;
      current += character;
      continue;
    }

    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += character;
      continue;
    }

    if (character === "," && parenDepth === 0) {
      families.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  families.push(current.trim());
  return families.filter((family) => family.length > 0);
}

function quoteFontFamily(family: string): string {
  return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizeSingleFontFamily(family: string): string {
  const trimmedFamily = family.trim();
  const lowerFamily = trimmedFamily.toLowerCase();

  if (
    trimmedFamily.startsWith('"') ||
    trimmedFamily.startsWith("'") ||
    trimmedFamily.includes("(") ||
    CSS_WIDE_KEYWORDS.has(lowerFamily) ||
    GENERIC_FONT_FAMILIES.has(lowerFamily)
  ) {
    return trimmedFamily;
  }

  return /\s/.test(trimmedFamily) ? quoteFontFamily(trimmedFamily) : trimmedFamily;
}

function unquoteFontFamily(family: string): string {
  const trimmedFamily = family.trim();
  const quote = trimmedFamily[0];
  if ((quote === '"' || quote === "'") && trimmedFamily.endsWith(quote)) {
    return trimmedFamily.slice(1, -1);
  }

  return trimmedFamily;
}

// Prepends the bundled variable alias for the families we self-host, keeping the
// requested name right behind it as a fallback. No-op for every other family.
function expandSelfHostedFontFamily(family: string): string {
  const alias = SELF_HOSTED_VARIABLE_FONT_FAMILIES.get(unquoteFontFamily(family).toLowerCase());
  return alias === undefined ? family : `${quoteFontFamily(alias)}, ${family}`;
}

function hasGenericFontFamily(value: string): boolean {
  return splitFontFamilyList(value).some((family) =>
    GENERIC_FONT_FAMILIES.has(unquoteFontFamily(family).toLowerCase()),
  );
}

export function normalizeFontFamilyCssValue(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim() ?? "";
  if (trimmedValue.length === 0) {
    return null;
  }

  return splitFontFamilyList(trimmedValue)
    .map(normalizeSingleFontFamily)
    .map(expandSelfHostedFontFamily)
    .join(", ");
}

// Keeps theme-provided code fonts from falling through to the browser's serif default.
export function normalizeMonospaceFontFamilyCssValue(
  value: string | null | undefined,
): string | null {
  const normalizedValue = normalizeFontFamilyCssValue(value);
  if (normalizedValue === null || CSS_WIDE_KEYWORDS.has(normalizedValue.toLowerCase())) {
    return normalizedValue;
  }

  return hasGenericFontFamily(normalizedValue)
    ? normalizedValue
    : `${normalizedValue}, ${DEFAULT_MONOSPACE_FONT_FAMILY_STACK}`;
}
