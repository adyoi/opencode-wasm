// Generate the demo server config:
//   - default to a free model
//   - allow every tool action so headless runs never block on a prompt
//   - only when the running server reports a version below 1.18.0, add per
//     model `user-agent` overrides so the free tier gateway accepts it
//     (snapshot dev builds report 0.0.0-dev-* and get HTTP 426)
//
// Usage: node scripts/config-demo.mjs [baseUrl] [configPath]
import { writeFileSync } from "node:fs"

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4096"
const target = process.argv[3] ?? process.env.OPENCODE_CONFIG
const preferred = process.env.OPENCODE_DEFAULT_MODEL ?? "opencode/space-bunny-free"
const allowAll = process.env.OPENCODE_ALLOW_ALL !== "false"

if (!target) {
  console.error("set OPENCODE_CONFIG or pass the config path as the second argument")
  process.exit(1)
}

const health = await (await fetch(`${baseUrl}/global/health`)).json().catch(() => ({}))
const [major, minor] = String(health.version ?? "0.0.0")
  .split(".")
  .map((part) => Number.parseInt(part, 10) || 0)
const freeTierBlocked = major < 1 || (major === 1 && minor < 18)

const { data: models } = await (await fetch(`${baseUrl}/api/model`)).json()
const free = models.filter((m) => (m.cost ?? []).every((c) => !c.input && !c.output))
if (free.length === 0) {
  console.error("no free models reported by the server")
  process.exit(1)
}

const provider = preferred.split("/")[0]
const overrides = {}
if (freeTierBlocked) {
  // Fallback for unpatched snapshot builds: the gateway reads the client
  // version out of the user-agent header.
  for (const model of free) overrides[model.id] = { headers: { "user-agent": "opencode/1.19.0" } }
}

const config = {
  $schema: "https://opencode.ai/config.json",
  model: preferred,
  ...(allowAll ? { permission: "allow" } : {}),
  provider: { [provider]: { models: overrides } },
}

writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, "utf8")
console.log(
  [
    `wrote ${target}`,
    `server ${health.version ?? "?"}`,
    `${free.length} free models`,
    `default ${preferred}`,
    `permissions ${allowAll ? "allow" : "ask"}`,
    freeTierBlocked ? "free tier: UA override needed (or run scripts/patch-version.mjs)" : "free tier: ok",
  ].join(" · "),
)
