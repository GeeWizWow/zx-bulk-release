import os from 'node:os'
import {$, fs, within} from 'zx-extra'
import {queuefy} from 'queuefy'
import {analyze} from './analyze.js'
import {build} from './build.js'
import {getPkgConfig} from './config.js'
import {topo, traverseQueue} from './deps.js'
import {log} from './log.js'
import {getLatest} from './meta.js'
import {publish} from './publish.js'
import {getRoot, getSha} from './repo.js'
import {get, memoizeBy, set, tpl} from './util.js'

export const run = async ({cwd = process.cwd(), env, flags = {}} = {}) => within(async () => {
  const {state, build, publish} = createContext(flags, env)

  log()('zx-bulk-release')

  try {
    const {packages, queue, root, sources, next, prev, nodes, graphs, edges} = await topo({cwd, flags})
    log()('queue:', queue)
    log()('graphs', graphs)

    state
      .setQueue(queue)
      .setPackages(packages)

    await traverseQueue({queue, prev, async cb(name) {
      state.setStatus('analyzing', name)
      const pkg = packages[name]
      await contextify(pkg, packages, root)
      await analyze(pkg, packages)
      state
        .set('config', pkg.config, name)
        .set('version', pkg.version, name)
        .set('prevVersion', pkg.latest.tag?.version || pkg.manifest.version, name)
        .set('releaseType', pkg.releaseType, name)
        .set('tag', pkg.tag, name)
    }})

    state.setStatus('pending')

    await traverseQueue({queue, prev, async cb(name) {
      const pkg = packages[name]

      if (!pkg.releaseType) {
        state.setStatus('skipped', name)
        return
      }

      state.setStatus('building', name)
      await build(pkg, packages)

      if (flags.dryRun) {
        state.setStatus('success', name)
        return
      }

      state.setStatus('publishing', name)
      await publish(pkg)

      state.setStatus('success', name)
    }})
  } catch (e) {
    log({level: 'error'})(e)
    state
      .set('error', e)
      .setStatus('failure')
    throw e
  }
  state.setStatus('success')
  log()('Great success!')
})

export const runCmd = async (pkg, name) => {
  const cmd = tpl(pkg.config[name], {...pkg, ...pkg.context})

  if (cmd) {
    log({pkg})(`run ${name} '${cmd}'`)
    await $.o({cwd: pkg.absPath, quote: v => v, preferLocal: true})`${cmd}`
  }
}

const createContext = (flags, env) => {
  const state = createState({file: flags.report})
  const _runCmd = queuefy(runCmd, flags.concurrency || os.cpus().length)
  const _build = memoizeBy((pkg, packages) => build(pkg, packages, _runCmd, _build))
  const _publish = memoizeBy((pkg) => publish(pkg, _runCmd))

  $.state = state
  $.env = {...process.env, ...env}
  $.verbose = !!(flags.debug || $.env.DEBUG ) || $.verbose

  return {
    state,
    runCmd: _runCmd,
    build: _build,
    publish: _publish
  }
}

// Inspired by https://docs.github.com/en/actions/learn-github-actions/contexts
export const contextify = async (pkg, packages, root) => {
  pkg.config = await getPkgConfig(pkg.absPath, root.absPath)
  pkg.latest = await getLatest(pkg)
  pkg.context = {
    git: {
      sha: await getSha(pkg.absPath),
      root: await getRoot(pkg.absPath)
    },
    env: $.env,
    packages
  }
}

export const createState = ({logger = console, file = null} = {}) => ({
  logger,
  file,
  status: 'initial',
  queue: [],
  packages: {},
  events: [],
  setQueue(queue) {
    this.queue = queue
    return this
  },
  setPackages(packages) {
    this.packages = Object.entries(packages).reduce((acc, [name, {manifest: {version}, absPath, relPath}]) => {
      acc[name] = {
        status: 'initial',
        name,
        version,
        path: absPath,
        relPath
      }
      return acc
    }, {})
    return this
  },
  get(key, pkgName) {
    return get(
      pkgName ? this.packages[pkgName] : this,
      key
    )
  },
  set(key, value, pkgName) {
    set(
      pkgName ? this.packages[pkgName] : this,
      key,
      value
    )
    return this
  },
  setStatus(status, name) {
    this.set('status', status, name)
    this.save()
    return this
  },
  getStatus(status, name) {
    return this.get('status', name)
  },
  log(ctx = {}) {
    return function (...chunks) {
      const {pkg, scope = pkg?.name || '~', level = 'info'} = ctx
      const msg = chunks.map(c => typeof c === 'string' ? tpl(c, ctx) : c)
      const event = {msg, scope, date: Date.now(), level}
      this.events.push(event)
      logger[level](`[${scope}]`, ...msg)
    }.bind(this)
  },
  save() {
    this.file && fs.outputJsonSync(this.file, this)
    return this
  }
})