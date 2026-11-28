import { assert, run, readJson, workspace, dist } from './npm-release.mjs'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const output = join(dist, 'npm')
mkdirSync(output, { recursive: true })
const staging = mkdtempSync(join(output, 'staging-'))
const components = ['adapter', 'runtime', 'shared']
const manifests = components.map(component => readJson(join(workspace, component, 'package.json')))
const internalEntries = new Map(manifests.map((manifest, index) => [
    manifest.name, join(staging, components[index], manifest.main),
]))

function copy(source, target = source) {
    cpSync(join(workspace, source), join(staging, target), { recursive: true })
}

function copyBuild(source, target) {
    for (const file of readdirSync(join(workspace, source), { recursive: true, withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.js') && !file.name.endsWith('.d.ts')) continue
        const sourceFile = join(file.parentPath, file.name)
        const targetFile = join(staging, target, relative(join(workspace, source), sourceFile))
        const contents = readFileSync(sourceFile, 'utf8')
            .replace(/(['"])(@agentarts\/harness-dsh-[\w-]+)\1/g, (specifier, quote, name) => {
                const entry = internalEntries.get(name)
                assert.ok(entry, `Unknown workspace import ${specifier} in ${sourceFile}`)
                const path = relative(dirname(targetFile), entry).split(sep).join('/')
                return `${quote}${path.startsWith('.') ? path : `./${path}`}${quote}`
            })
            .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
        mkdirSync(dirname(targetFile), { recursive: true })
        writeFileSync(targetFile, contents)
    }
}

try {
    const manifest = readJson(join(workspace, 'npm/package.json'))
    manifest.engines = readJson(join(workspace, 'package.json')).engines
    manifest.dependencies = {}
    for (const component of manifests) {
        for (const [name, version] of Object.entries(component.dependencies ?? {})) {
            if (internalEntries.has(name)) continue
            assert.ok(!/^(workspace:|file:|link:)/.test(version), `Unresolved dependency ${name}: ${version}`)
            assert.ok(!manifest.dependencies[name] || manifest.dependencies[name] === version,
                `Conflicting versions for ${name}`)
            manifest.dependencies[name] = version
        }
    }
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    for (const component of components) copyBuild(`${component}/dist`, `${component}/dist`)
    copyBuild('dist/tools', 'tools')
    copy('npm/bin', 'bin')
    chmodSync(join(staging, manifest.bin['agentarts-adapter']), 0o755)
    copy('runtime/plugins')
    for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml.tmpl']) copy(`profile/${file}`)

    const profile = readJson(join(workspace, 'profile/package.json'))
    for (const dependency of Object.values(profile.dependencies)) {
        if (!dependency.startsWith('file:./vendor/')) continue
        const plugin = `plugins/${dependency.slice('file:./vendor/'.length)}`
        const metadata = readJson(join(workspace, plugin, 'package.json'))
        copy(`${plugin}/package.json`)
        for (const asset of metadata.files) {
            // Plugin manifests use locale/*.json for translations and an exact path for other assets.
            copy(`${plugin}/${asset === 'locale/*.json' ? 'locale' : asset}`)
        }
        if (plugin.endsWith('/agentarts-instrumentation-dsh')) copy(`${plugin}/VENDORED.md`)
    }
    copy('../README.md', 'README.md')
    copy('../LICENSE', 'LICENSE')

    const [pack] = JSON.parse(run('npm', [
        'pack', '--json', '--ignore-scripts', '--pack-destination', output,
    ], { cwd: staging, capture: true }))
    console.log(join(output, pack.filename))
} finally {
    rmSync(staging, { recursive: true, force: true })
}
