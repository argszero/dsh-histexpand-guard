#!/usr/bin/env node
/**
 * A `peerDependencies` range is a claim about versions nobody ran. This script
 * makes the claim checkable instead of asserted: for each line the range admits,
 * it copies this package into a scratch directory, pins **the whole line**,
 * installs, builds, and runs the suite.
 *
 * The lines come from the manifest, not from a list here — a probe with its own
 * copy of the contract can drift from the thing it is supposed to be checking.
 * Each `||` segment of the range is one line, and its **newest** published build
 * is the representative: the earliest build of a line is an alpha nobody is left
 * on, and probing it says less than probing the build the line converged to.
 *
 * Three rules this probe follows, because violating any of them measures the
 * probe rather than the line:
 *
 * 1. **The whole line is pinned, not the packages this plugin happens to
 *    import.** The set of harness packages a line carries grows between lines,
 *    so it is read from that line's own `@deepseek-ai/dsh-agent` manifest rather
 *    than written down here, and it is widened by every `@deepseek-ai/dsh-*`
 *    this package declares (either in `peerDependencies` or in
 *    `devDependencies`, which is what the probe tree installs). Pinning a subset
 *    leaves npm free to resolve the rest from another line, and the resulting
 *    tree is not the line.
 * 2. **`--legacy-peer-deps`.** Without it npm derives peers transitively and can
 *    install a second line's copy of a package to satisfy them — again a tree
 *    that is not the line. The installation is `npm ci`-free on purpose: there
 *    is no lockfile to honour, the pins *are* the specification.
 * 3. **Every pinned package's version is read back after install.** A pin that
 *    silently did not apply is the failure mode this whole script exists to
 *    prevent, so it is asserted rather than assumed, and the assertion runs
 *    before the suite so a mixed tree can never be reported as a passing line.
 *
 * ```sh
 * npm run test:probe-lines                 # every line the range admits
 * npm run test:probe-lines -- 0.2.0-rc.2   # one line
 * npm run test:probe-lines -- --keep       # leave the scratch trees in place
 * ```
 *
 * A line that fails here is removed from the range (manifest, README and the
 * `SUPPORTED_LINES` contract in `test/packaging.spec.mjs`) rather than left
 * claimed. This script is development-only and is not published.
 *
 * @module scripts/probe-lines
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** What is copied into the scratch tree; everything else is not needed to test. */
const COPIED = ['src', 'test', 'scripts', 'tsconfig.json', 'README.md', 'LICENSE', 'cordis.patch.yml']

/**
 * Harness packages this plugin needs that a line's own manifest does not name.
 *
 * These are **transitive requirements the published metadata does not declare**:
 * the installed builds import them and nothing in the corresponding
 * `package.json` asks for them, so a tree that installs only the declared graph
 * cannot load the packages this suite actually imports. A real deployment never
 * notices, because the profile's lockfile carries them.
 *
 * Measured, not guessed: each entry was found by installing the declared graph
 * for the line and walking the `@deepseek-ai/dsh-*` specifiers of every
 * installed build. For this line the walk found two — `dsh-tools` imports
 * `@deepseek-ai/dsh-sandbox`, and `dsh-workspace` imports
 * `@deepseek-ai/dsh-storage-domain` — and neither is in the importer's own
 * manifest.
 *
 * `@deepseek-ai/cordis` is deliberately NOT pinned to the line: its versions do
 * not follow the harness's line numbering, so it stays at whatever the
 * manifest's `devDependencies` already pin.
 */
const EXTRA = [
  '@deepseek-ai/dsh-sandbox',
  '@deepseek-ai/dsh-storage-domain',
]

/**
 * The newest published build of each `||` segment of a range.
 * @param range - a semver range, composed of `||` segments.
 * @param versions - every published version of the package.
 * @returns one version per segment, in range order.
 */
function representativesOf(range, versions) {
  return range.split('||')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .map(segment => semver.maxSatisfying(versions, segment))
}

/**
 * Every `@deepseek-ai/dsh-*` package one line carries, read from that line's own
 * `dsh-agent` manifest.
 *
 * Read rather than written down: the set grows between lines, so a list here
 * would be a second, silently stale copy of the contract — and the packages it
 * left out would be resolved from whatever line npm prefers.
 * @param line - the line to read.
 * @returns the package names, or an empty array when the manifest is unreachable.
 */
function linePackages(line) {
  try {
    const raw = execFileSync(
      'npm', ['view', `@deepseek-ai/dsh-agent@${line}`, 'peerDependencies', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return Object.keys(JSON.parse(raw || '{}')).filter(name => name.startsWith('@deepseek-ai/dsh-'))
  } catch {
    return []
  }
}

/** Whether one package has a build at exactly this line. */
function publishedAt(name, line) {
  try {
    execFileSync('npm', ['view', `${name}@${line}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

/**
 * Install the pinned tree, then assert that the pins are what was installed.
 *
 * `--legacy-peer-deps` is the second rule in the header: without it npm derives
 * peer requirements transitively and can satisfy them with another line's copy.
 * @param dir - the probe tree.
 * @param log - the progress writer.
 * @param pins - the exact versions the tree was supposed to get.
 * @param line - the line being probed.
 */
function install(dir, log, pins, line) {
  const options = { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] }
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], options)
  const resolved = []
  for (const name of Object.keys(pins)) {
    const installed = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version
    resolved.push(`${name.replace('@deepseek-ai/dsh-', '')}@${installed}`)
    if (installed !== line) {
      throw new Error(`the pin did not apply: ${name} resolved to ${installed}, not ${line}`)
    }
  }
  log(`    pinned ${resolved.length}: ${resolved.join(' ')}`)
}

/** Install one probe and run the suite in it. */
function probe(line) {
  const dir = mkdtempSync(join(tmpdir(), `histexpand-guard-${line}-`))
  const log = message => process.stdout.write(`${message}\n`)
  log(`\n=== ${line} — ${dir}`)

  const declared = [
    ...Object.keys(manifest.peerDependencies),
    ...Object.keys(manifest.devDependencies),
    ...linePackages(line),
    ...EXTRA,
  ]
  const names = [...new Set(declared)]
    .filter(name => name.startsWith('@deepseek-ai/dsh-'))
    // A package the line never shipped cannot be pinned to it. Dropped rather
    // than silently resolved from another line: the count is printed, because a
    // dropped name is one hole in "the whole line" that the reader should see.
    .filter(name => publishedAt(name, line))
  const pins = Object.fromEntries(names.map(name => [name, line]))
  log(`    pinning ${names.length} harness packages${declared.length - names.length > 0 ? ` (${declared.length - names.length} not published at this line, left unpinned)` : ''}`)

  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    ...manifest,
    // The pins live in `devDependencies` so the tree is exactly the line: the
    // peers are then satisfied by it, and nothing else is installed for them.
    devDependencies: { ...manifest.devDependencies, ...pins },
    // No `test:probe-lines` here: the probe must not be able to recurse.
    scripts: { build: 'tsc', test: 'tsc && node --test "test/*.spec.mjs"' },
  }, null, 2)}\n`)

  try {
    install(dir, log, pins, line)
    execFileSync('npm', ['test'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
    log(`=== ${line}: PASS`)
    return true
  } catch (error) {
    if (error.stdout !== undefined) process.stdout.write(String(error.stdout))
    log(`=== ${line}: FAIL — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    return false
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const requested = argv.filter(argument => !argument.startsWith('-'))

const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
const published = JSON.parse(execFileSync('npm', ['view', '@deepseek-ai/dsh-tools', 'versions', '--json'], { encoding: 'utf8' }))
const lines = requested.length > 0 ? requested : representativesOf(range, published)

const failed = lines.filter(line => !probe(line))
process.stdout.write(`\nprobed ${lines.length} line(s) of ${range}\n`)
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.join(', ')} — remove them from the range, the README and SUPPORTED_LINES\n`)
  process.exitCode = 1
}
