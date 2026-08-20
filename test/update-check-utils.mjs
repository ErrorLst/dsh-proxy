// Pure-helper unit tests for the update-check machinery: tag prefix
// stripping, semver-ish comparison, and the HTML markdown-body extractor.
// Run:  node test/update-check-utils.mjs   (OUTF env var optional)
import fs from "node:fs";
import { compareVersions, extractMarkdownBody, stripTagPrefixes } from "@dsh-external/dsh-proxy";

const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
};

// ---- stripTagPrefixes ----
assert(stripTagPrefixes("dsh-v0.1.0-rc.7") === "0.1.0-rc.7", "strip dsh-v prefix");
assert(stripTagPrefixes("dsh_v0.1.0") === "0.1.0", "strip dsh_ prefix");
assert(stripTagPrefixes("v1.2.3") === "1.2.3", "strip v prefix");
assert(stripTagPrefixes("1.2.3") === "1.2.3", "bare version unchanged");
assert(stripTagPrefixes("  v0.1.0  ") === "0.1.0", "trimmed then stripped");

// ---- compareVersions ----
assert(compareVersions("0.2.0", "0.1.0-rc.7") === 1, "release beats older prerelease");
assert(compareVersions("0.1.0-rc.7", "0.1.0") === -1, "prerelease sorts below release");
assert(compareVersions("0.1.0-rc.8", "0.1.0-rc.7") === 1, "rc bump");
assert(compareVersions("0.1.0-rc.7", "0.1.0-rc.7") === 0, "equal prerelease");
assert(compareVersions("dsh-v0.1.0-rc.7", "0.1.0-rc.7") === 0, "tag prefix ignored");
assert(compareVersions("0.1.10", "0.1.9") === 1, "two-digit patch");
assert(compareVersions("0.1.0-rc.10", "0.1.0-rc.9") === 1, "numeric prerelease parts compare numerically");
assert(compareVersions("0.1.0-alpha.1", "0.1.0-rc.1") === -1, "alpha < rc");
assert(compareVersions("0.1.0-1", "0.1.0-alpha") === -1, "numeric identifier sorts below alphanumeric");
assert(compareVersions("1.0.0", "1.0") === 0, "short core pads with zeros");
assert(compareVersions("0.1.0-rc.7", "0.1.0-rc.7.1") === -1, "longer prerelease after equal prefix");

// ---- extractMarkdownBody ----
const sample =
  '<html><body><div class="markdown-body"><h2>New Features</h2><ul><li>a &amp; b</li></ul><div><p>nested</p></div></div><div>trailer</div></body></html>';
const body = extractMarkdownBody(sample);
assert(body !== null, "extracts the markdown body");
assert(body.includes("New Features") && body.includes("a & b") && body.includes("nested"), "content preserved and entities decoded");
assert(!body.includes("<") && !body.includes("trailer"), "tags stripped, trailing content excluded");
assert(extractMarkdownBody("<html><p>no body</p></html>") === null, "no markdown-body div -> null");

const result = { stripTagPrefixes: "ok", compareVersions: "ok", extractMarkdownBody: "ok" };
const text = JSON.stringify(result, null, 2);
if (process.env.OUTF) fs.writeFileSync(process.env.OUTF, text);
console.log(text);
console.log("UPDATE-CHECK-UTILS: ALL PASSED");
process.exit(0);
