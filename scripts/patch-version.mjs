// Rewrite the version string baked into a snapshot opencode build.
//
// Snapshot builds (`opencode-ai@dev`) report `0.0.0-dev-<date>`, and the
// free-tier gateway answers HTTP 426 "OpenCode 1.18.0 or newer is required".
// The version is baked into the binary at build time, so the only way to fix
// it without rebuilding from source is to rewrite that constant in place.
//
// The replacement keeps the exact byte length (`0.0.0-dev-XXXXXXXXXXXX` ->
// `1.19.0-dev-XXXXXXXXXXXX`) so no offsets inside the Bun payload shift.
//
// Usage: node scripts/patch-version.mjs <opencode.exe> [newVersion]
import { readFileSync, writeFileSync } from "node:fs"

const [, , binary, requested = "1.19.0"] = process.argv
if (!binary) {
  console.error("usage: node scripts/patch-version.mjs <opencode.exe> [version]")
  process.exit(1)
}

const bytes = readFileSync(binary)
const needle = Buffer.from("0.0.0-dev-", "utf8")

const hits = []
let at = bytes.indexOf(needle)
while (at !== -1) {
  // version literal = "0.0.0-dev-" + 12 trailing characters (date + build id)
  const end = at + needle.length + 12
  hits.push({ at, text: bytes.subarray(at, end).toString("utf8") })
  at = bytes.indexOf(needle, at + 1)
}

if (hits.length === 0) {
  console.log("no 0.0.0-dev-* literal found, nothing to patch")
  process.exit(0)
}

const version = requested.padEnd(needle.length + 12, "-").slice(0, needle.length + 12)
const patch = Buffer.from(version, "utf8")
if (patch.length !== needle.length + 12) {
  console.error(`replacement must be exactly ${needle.length + 12} bytes, got ${patch.length}`)
  process.exit(1)
}

for (const hit of hits) {
  patch.copy(bytes, hit.at)
}
writeFileSync(binary, bytes)

console.log(`patched ${hits.length} occurrence(s) of ${hits[0].text} -> ${version} in ${binary}`)
