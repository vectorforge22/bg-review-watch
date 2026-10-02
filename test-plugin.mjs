import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8')
const version = readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim()
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'VERSION must be valid SemVer')
const eventHandlers = new Map()
const host = {
  logs: async () => ({ lines: [] }),
  onEvent(type, handler) {
    eventHandlers.set(type, handler)
    return () => eventHandlers.delete(type)
  },
  request: async () => ({}),
}

function synthetic(exports) {
  const names = Object.keys(exports)
  return new vm.SyntheticModule(names, function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  })
}

const modules = new Map([
  ['@hermes/plugin-sdk', synthetic({
    host,
    STATUSBAR_AREAS: { right: 'statusBar.right' },
    Tip: function Tip() {},
  })],
  ['react/jsx-runtime', synthetic({
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  })],
  ['react', synthetic({
    useEffect: () => {},
    useState: initial => [initial, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  })],
])

const pluginModule = new vm.SourceTextModule(source, { identifier: 'bg-review-watch/plugin.js' })
await pluginModule.link(specifier => {
  const linked = modules.get(specifier)
  assert.ok(linked, `unexpected import: ${specifier}`)
  return linked
})
await pluginModule.evaluate()

const plugin = pluginModule.namespace.default
assert.equal(plugin.id, 'bg-review-watch')
assert.equal(plugin.defaultEnabled, true)

const contributions = []
let dispose = () => {}
plugin.register({
  register: contribution => contributions.push(contribution),
  onDispose: callback => { dispose = callback },
})

assert.deepEqual(contributions.map(item => item.id), ['chip', 'chip-compact', 'chip-guard'])
assert.ok(eventHandlers.has('message.start'))
assert.ok(eventHandlers.has('message.complete'))
assert.ok(eventHandlers.has('review.summary'))

dispose()
assert.equal(eventHandlers.size, 0)
console.log(`bg-review-watch v${version} smoke test passed`)
