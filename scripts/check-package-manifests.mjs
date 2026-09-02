import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(new URL("..", import.meta.url)))
const readManifest = relative => JSON.parse(readFileSync(join(root, relative), "utf8"))
const rootManifest = readManifest("package.json")
const tabbyManifest = readManifest("tabby-plugin/package.json")
const lockfile = readManifest("package-lock.json")

const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value ?? {}).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ") || "none"}; found: ${actual.join(", ") || "none"}`)
  }
}

exactKeys(rootManifest.dependencies, [], "root dependencies")
exactKeys(tabbyManifest.dependencies, [], "Tabby dependencies")
exactKeys(rootManifest.peerDependencies, ["@opencode-ai/plugin"], "root peerDependencies")
exactKeys(tabbyManifest.peerDependencies, ["tabby-core", "tabby-local", "tabby-settings", "tabby-terminal"], "Tabby peerDependencies")
if (rootManifest.dependencies?.[tabbyManifest.name]) throw new Error("root must not depend on its Tabby workspace")

for (const [label, manifest, lockKey] of [["root", rootManifest, ""], ["Tabby", tabbyManifest, "tabby-plugin"]]) {
  const locked = lockfile.packages?.[lockKey]
  if (!locked) throw new Error(`${label} package is missing from package-lock.json`)
  if (locked.name !== manifest.name || locked.version !== manifest.version) throw new Error(`${label} lock entry name/version does not match its manifest`)
  exactKeys(locked.dependencies, Object.keys(manifest.dependencies ?? {}), `${label} lock dependencies`)
  exactKeys(locked.peerDependencies, Object.keys(manifest.peerDependencies ?? {}), `${label} lock peerDependencies`)
}

console.log("Package manifests declare no runtime dependencies; peer contracts are explicit.")
