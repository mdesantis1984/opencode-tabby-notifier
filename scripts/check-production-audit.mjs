import { execFileSync } from "node:child_process"

const allowedHostPackages = new Set([
  "@angular/animations", "@angular/cdk", "@angular/common", "@angular/compiler",
  "@angular/core", "@angular/forms", "@angular/localize", "@angular/platform-browser",
  "@angular/platform-browser-dynamic", "@ng-bootstrap/ng-bootstrap", "tabby-core",
  "tabby-local", "tabby-settings", "tabby-terminal",
  "@babel/core",
])

let report
try {
  report = JSON.parse(execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8" }))
} catch (error) {
  report = JSON.parse(error.stdout?.toString() ?? "{}")
}
const vulnerabilities = report.vulnerabilities ?? {}
const unknown = Object.entries(vulnerabilities).filter(([name]) => !allowedHostPackages.has(name))
const critical = Object.entries(vulnerabilities).filter(([, item]) => item.severity === "critical")
console.log(JSON.stringify({ production: report.metadata?.vulnerabilities ?? {}, acceptedHostPackages: Object.keys(vulnerabilities).filter(name => allowedHostPackages.has(name)), unknown: unknown.map(([name]) => name) }))
if (critical.length || unknown.length) process.exit(1)
