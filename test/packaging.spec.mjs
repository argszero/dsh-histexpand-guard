/**
 * Packaging guard: the published artifact must declare every bare specifier it
 * imports, must not declare packages it never mentions, must actually ship the
 * files the manifest promises — and must describe its own compatibility range
 * the same way in the manifest and in the README.
 *
 * Each arm is a defect this family has already shipped once somewhere:
 *
 * - A value import declared only in `devDependencies` resolves on the publishing
 *   machine and fails for a consumer with `ERR_MODULE_NOT_FOUND`.
 * - A `files` list that names the entry but not its modules publishes a package
 *   whose own relative imports are missing.
 * - A peer range written too long admits lines where an imported symbol does not
 *   exist; quoted only partially in the README, the documentation becomes the
 *   trap. Both halves are asserted against one list of supported lines.
 *
 * `npm pack --dry-run` is deliberate: it uses npm's own matcher, where a
 * hand-rolled glob would be the same guess the defect is made of.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * The prerelease lines this plugin claims to work on.
 *
 * The lines were probed with `npm run test:probe-lines`, which pins every
 * harness package to one line and runs the suite against it. Adding a line here
 * without running that is how a wrong range gets published, so the list is the
 * contract and the manifest has to agree with it — not the other way round.
 */
const SUPPORTED_LINES = ['0.1.7-rc.2', '0.2.0-rc.2']

/** Every file under `dir` whose name ends with one of `extensions`. */
function walk(dir, extensions, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, extensions, found)
    else if (extensions.some(extension => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

/** Specifiers reached by static import/export (value or type), `import()` and `require()`. */
function allSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;{])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{])(?:import|export)\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers]
}

/** Specifiers a loader resolves at run time: `import x from 'y'`, not `import type { X } from 'y'`. */
function valueSpecifiers(source) {
  return allSpecifiers(source).filter((specifier) => {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:import|export)\\s+(?!type\\b)[^'"]*?from\\s*['"]${escaped}['"]`).test(source)
  })
}

/** Bare (installable) specifiers only: relative targets and `node:` builtins are not packages. */
function bareSpecifiers(source) {
  return allSpecifiers(source).filter(specifier =>
    !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:'))
}

/** The package a specifier resolves to: `@scope/name` or `name`, subpath dropped. */
function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const runtimeDeclared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])

/** The harness packages whose API this plugin is compiled against. */
const dshPeers = Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))

const sourceFiles = [...walk(join(ROOT, 'src'), ['.ts']), ...walk(join(ROOT, 'lib'), ['.js'])]
const imported = new Set()
const importedForValue = new Set()
for (const file of sourceFiles) {
  const source = readFileSync(file, 'utf8')
  for (const specifier of bareSpecifiers(source)) imported.add(packageOf(specifier))
  for (const specifier of valueSpecifiers(source)) {
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    importedForValue.add(packageOf(specifier))
  }
}

/** What npm itself would put in the tarball. */
function packedPaths() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' })
  const parsed = JSON.parse(output)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return new Set(entry.files.map(file => file.path))
}

test('the guard has something to guard', () => {
  // A walk that silently finds nothing would make every assertion below vacuous.
  const relative = sourceFiles.flatMap(file =>
    allSpecifiers(readFileSync(file, 'utf8')).filter(specifier => specifier.startsWith('.')))
  assert.ok(sourceFiles.some(file => file.endsWith(join('src', 'index.ts'))), 'src/index.ts must be scanned')
  assert.ok(sourceFiles.some(file => file.endsWith(join('lib', 'index.js'))), 'lib/index.js must be built and scanned')
  // This plugin plugs into one registry and reads the terminal service through
  // the context, so its runtime import surface is the registry and the vendored
  // context — two, where the sandbox-family plugins import four or five. Named
  // rather than counted: a count would pass on any two packages, and what has to
  // be seen is these. `terminals` is deliberately structural (an interface over
  // `ctx.get`), which is why it must not appear here as a third peer.
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']) {
    assert.ok(imported.has(name), `the walk must find the import of ${name}, saw ${[...imported].join(', ')}`)
  }
  assert.ok(relative.length >= 4, `expected the entry to import its own modules, saw ${relative.length} relative specifiers`)
})

test('every bare import in the published artifact is declared', () => {
  const undeclared = [...imported].filter(name => !runtimeDeclared.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `imported by shipped code but not declared in dependencies/peerDependencies: ${undeclared.join(', ')}`
      + ' — a consumer installing this package by name gets ERR_MODULE_NOT_FOUND',
  )
})

test('every value import is declared for run time, not only for the build', () => {
  // `devDependencies` is where the publishing machine's tree comes from; a
  // consumer never installs it. Only the peers and the dependencies are real.
  assert.ok(importedForValue.has('@deepseek-ai/dsh-tools'), 'the tool definition is a value import and must be seen')
  for (const name of importedForValue) {
    assert.ok(runtimeDeclared.has(name), `${name} is imported for value but is only a devDependency`)
  }
})

test('no runtime declaration is left over from a version this plugin no longer describes', () => {
  const unused = [...runtimeDeclared].filter(name => !imported.has(name))
  assert.deepEqual(unused, [], `declared but never imported by shipped code: ${unused.join(', ')}`)
})

test('every harness peer range admits exactly the lines this plugin claims, and no next minor', () => {
  assert.ok(dshPeers.includes('@deepseek-ai/dsh-tools'), `expected the registry peer to be declared, saw ${dshPeers.join(', ')}`)
  for (const name of dshPeers) {
    const range = manifest.peerDependencies[name]
    assert.ok(typeof range === 'string' && range.length > 0, `${name} must carry a range`)
    for (const line of SUPPORTED_LINES) {
      assert.ok(semver.satisfies(line, range), `the peer range for ${name} rejects ${line}, which the README claims`)
    }
    assert.ok(!semver.satisfies('0.2.0', range), `the peer range for ${name} must not admit the next minor line`)
    assert.ok(!semver.satisfies('0.1.6', range), `the peer range for ${name} must not reach back past the line the API is read through`)
  }
})

test('the README quotes the range it is describing, in full', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  // A README that quotes only the first `||` segment is a trap: it admits lines
  // where the symbol this plugin imports does not exist.
  const quoted = new Set(dshPeers.map(name => manifest.peerDependencies[name]))
  for (const range of quoted) {
    assert.ok(readme.includes(range.replace(/\|/g, '\\|')) || readme.includes(range),
      `the README must quote the peer range ${range} verbatim (pipes escaped inside a table)`)
  }
  for (const line of SUPPORTED_LINES) {
    assert.ok(readme.includes(line), `the README must name the ${line} line it was verified against`)
  }
})

test('the tarball carries the entry, its modules, the bundle patch, and the type declarations', () => {
  const paths = packedPaths()
  for (const required of [
    'package.json',
    'lib/index.js', 'lib/advice.js', 'lib/config.js', 'lib/scan.js', 'lib/policy.js',
    'lib/types/index.d.ts', 'lib/types/advice.d.ts', 'lib/types/config.d.ts',
    'lib/types/scan.d.ts', 'lib/types/policy.d.ts',
    'cordis.patch.yml', 'README.md', 'LICENSE',
  ]) {
    assert.ok(paths.has(required), `npm pack omits ${required} (declared in "files"): ${[...paths].join(', ')}`)
  }
  assert.ok(![...paths].some(path => path.startsWith('test/') || path.startsWith('src/') || path.startsWith('scripts/')),
    'source, tests and scripts stay unpublished')
})

test('every manifest entry point is in the tarball, and the patch names this plugin', () => {
  const paths = packedPaths()
  assert.ok(paths.has(manifest.main), `"main" (${manifest.main}) is not in the tarball`)
  assert.ok(paths.has(manifest.types), `"types" (${manifest.types}) is not in the tarball`)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'the bundle patch declaration points at the shipped file')
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(manifest.name), 'the bundle patch must mount this package by name')
  assert.ok(patch.includes('histexpand-guard'), 'the bundle patch must use this plugin\'s id')
  // The README is where the upstream fix has to be named: this plugin is a
  // refusal, and an operator who reads only the plugin would never learn that
  // the hazard is removable for every command instead of provable per command.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes('set +o histexpand'), 'the README must name the upstream one-line fix')
})

test('every relative import inside the tarball resolves to a file the tarball contains', () => {
  const paths = packedPaths()
  let checked = 0
  for (const file of [...paths].filter(path => path.startsWith('lib/') && path.endsWith('.js'))) {
    for (const specifier of allSpecifiers(readFileSync(join(ROOT, file), 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      checked += 1
      const target = resolve(ROOT, dirname(file), specifier)
      const candidates = [target, `${target}.js`, join(target, 'index.js')]
      assert.ok(
        candidates.some(candidate => paths.has(resolve(candidate).slice(ROOT.length + 1))),
        `${file} imports ${specifier}, which the tarball does not contain`,
      )
    }
  }
  // The entry imports four of its own modules; a walk that found fewer would be
  // checking a different artifact than the one being published.
  assert.ok(checked >= 4, `expected to check the entry's own modules, checked ${checked}`)
})

test('the published version is the one the README documents', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes(`${manifest.name}@${manifest.version}`)
    || !readme.includes(`${manifest.name}@`),
  'the README must not name a version other than the published one')
})
