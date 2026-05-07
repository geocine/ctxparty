import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);

function resolvePiTuiUtilsPath() {
  const packagePath = require.resolve("@mariozechner/pi-tui/package.json");
  return join(dirname(packagePath), "dist", "utils.js");
}

function patchPiTuiUtils() {
  let utilsPath;
  try {
    utilsPath = resolvePiTuiUtilsPath();
  } catch {
    return;
  }

  const original = readFileSync(utilsPath, "utf8");
  if (!original.includes("$/v") && !original.includes("RGI_Emoji")) {
    return;
  }

  let patched = original.replace(
    `const zeroWidthRegex = /^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Mark}|\\p{Surrogate})+$/v;
const leadingNonPrintingRegex = /^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+/v;
const rgiEmojiRegex = /^\\p{RGI_Emoji}$/v;`,
    `const zeroWidthRegex = /^(?:[\\u0000-\\u001f\\u007f-\\u009f]|\\p{Mark}|\\p{Cf}|\\p{Cs})+$/u;
const leadingNonPrintingRegex = /^[\\u0000-\\u001f\\u007f-\\u009f\\p{Mark}\\p{Cf}\\p{Cs}]+/u;
function isEmojiSegment(segment) {
    const cp = segment.codePointAt(0);
    return cp !== undefined && ((cp >= 0x1f000 && cp <= 0x1fbff) ||
        (cp >= 0x2600 && cp <= 0x27bf) ||
        (cp >= 0x2300 && cp <= 0x23ff) ||
        segment.includes("\\uFE0F") ||
        segment.includes("\\u200D"));
}`,
  );

  patched = patched.replace(
    "if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {",
    "if (couldBeEmoji(segment) && isEmojiSegment(segment)) {",
  );

  if (patched !== original) {
    writeFileSync(utilsPath, patched);
  }
}

patchPiTuiUtils();
