import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const manifest = readJson('package.json')
const lock = readJson('package-lock.json')
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
const errors = []

for (const [label, version] of [
  ['package-lock.json', lock.version],
  ['package-lock.json root', lock.packages?.['']?.version],
]) {
  if (version !== manifest.version) errors.push(`${label} version ${version} does not match ${manifest.version}`)
}
if (!changelog.split(/\r?\n/).some((line) => line.trim() === `## ${manifest.version}`)) {
  errors.push(`CHANGELOG.md has no exact ## ${manifest.version} release heading`)
}
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
    if (/^(?:file:|link:|workspace:)/.test(specifier)) errors.push(`${section} contains local dependency ${name}: ${specifier}`)
  }
}
const tagIndex = process.argv.indexOf('--tag')
if (tagIndex !== -1 && process.argv[tagIndex + 1] !== `v${manifest.version}`) {
  errors.push(`release tag ${process.argv[tagIndex + 1]} does not match v${manifest.version}`)
}
if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}
console.log(`Release metadata is consistent for ${manifest.name} ${manifest.version}.`)
