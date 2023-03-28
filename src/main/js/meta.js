// Semantic tags processing

import {Buffer} from 'node:buffer'
import {queuefy} from 'queuefy'
import {semver, $, fs, path} from 'zx-extra'
import {log} from './log.js'
import {fetchRepo, pushCommit, getTags as getGitTags, pushTag} from './git.js'
import {fetchManifest} from './npm.js'

export const pushReleaseTag = async (pkg) => {
  const {name, version, config: {gitCommitterEmail, gitCommitterName}} = pkg
  const tag = formatTag({name, version})
  const cwd = pkg.context.git.root

  pkg.context.git.tag = tag
  log({pkg})(`push release tag ${tag}`)

  await pushTag({cwd, tag, gitCommitterEmail, gitCommitterName})
}

export const pushMeta = queuefy(async (pkg) => {
  log({pkg})('push artifact to branch \'meta\'')

  const {name, version, absPath: cwd, config: {gitCommitterEmail, gitCommitterName, ghBasicAuth: basicAuth}} = pkg
  const tag = formatTag({name, version})
  const to = '.'
  const branch = 'meta'
  const msg = `chore: release meta ${name} ${version}`
  const hash = (await $.o({cwd})`git rev-parse HEAD`).toString().trim()
  const meta = {
    META_VERSION: '1',
    name: pkg.name,
    hash,
    version: pkg.version,
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    peerDependencies: pkg.peerDependencies,
    optionalDependencies: pkg.optionalDependencies,
  }
  const files = [{relpath: `${getArtifactPath(tag)}.json`, contents: meta}]

  await pushCommit({cwd, to, branch, msg, files, gitCommitterEmail, gitCommitterName, basicAuth})
})

export const getLatest = async (pkg) => {
  const {absPath: cwd, name, config: {ghBasicAuth: basicAuth}} = pkg
  const tag = await getLatestTag(cwd, name)
  const meta = await getLatestMeta(cwd, tag?.ref, basicAuth) || await fetchManifest(pkg, {nothrow: true})

  return {
    tag,
    meta
  }
}

const f0 = {
  parse(tag) {
    if (!tag.endsWith('-f0')) return null

    const pattern = /^(\d{4}\.(?:[1-9]|1[012])\.(?:[1-9]|[12]\d|30|31))-((?:[a-z0-9-]+\.)?[a-z0-9-]+)\.(v?\d+\.\d+\.\d+.*)-f0$/
    const matched = pattern.exec(tag) || []
    const [, _date, _name, version] = matched

    if (!semver.valid(version)) return null

    const date = parseDateTag(_date)
    const name = _name.includes('.') ? `@${_name.replace('.', '/')}` : _name

    return {date, name, version, format: 'f0', ref: tag}
  },
  format({name, date = new Date(), version}) {
    if (!/^(@?[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name) || !semver.valid(version)) return null

    const d = formatDateTag(date)
    const n = name.replace('@', '').replace('/', '.')

    return `${d}-${n}.${version}-f0`
  }
}

const f1 = {
  parse(tag) {
    if (!tag.endsWith('-f1')) return null

    const pattern = /^(\d{4}\.(?:[1-9]|1[012])\.(?:[1-9]|[12]\d|30|31))-[a-z0-9-]+\.(v?\d+\.\d+\.\d+.*)\.([^.]+)-f1$/
    const matched = pattern.exec(tag) || []
    const [, _date, version, b64] = matched

    if (!semver.valid(version)) return null

    const date = parseDateTag(_date)
    const name = Buffer.from(b64, 'base64url').toString('utf8')

    return {date, name, version, format: 'f1', ref: tag}
  },
  format({name, date = new Date(), version}) {
    if (!semver.valid(version)) return null

    const b64 = Buffer.from(name).toString('base64url')
    const d = formatDateTag(date)
    const n = name.replace(/[^a-z0-9-]/ig, '')

    return `${d}-${n}.${version}.${b64}-f1`
  }
}

const lerna = {
  parse(tag) {
    const pattern = /^(@?[a-z0-9-]+(?:\/[a-z0-9-]+)?)@(v?\d+\.\d+\.\d+.*)/
    const [, name, version] = pattern.exec(tag) || []

    if (!semver.valid(version)) return null

    return {name, version, format: 'lerna', ref: tag}
  },
  // format({name, version}) {
  //   if (!semver.valid(version)) return null
  //
  //   return `${name}@${version}`
  // }
}

// TODO
// const variants = [f0, f1]
// export const parseTag = (tag) => {
//   for (const variant of variants) {
//     const parsed = variant.parse(tag)
//     if (parsed) return parsed
//   }
//
//   return null
// }

export const parseTag = (tag) => f0.parse(tag) || f1.parse(tag) || lerna.parse(tag) || null

export const formatTag = (tag) => f0.format(tag) || f1.format(tag) || null

export const getTags = async (cwd, ref = '') =>
  (await getGitTags(cwd, ref))
    .map(tag => parseTag(tag.trim()))
    .filter(Boolean)
    .sort((a, b) => semver.rcompare(a.version, b.version))

export const getLatestTag = async (cwd, name) =>
  (await getTags(cwd)).find(tag => tag.name === name) || null

export const getLatestTaggedVersion = async (cwd, name) =>
  (await getLatestTag(cwd, name))?.version || null

export const formatDateTag = (date = new Date()) => `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`

export const parseDateTag = (date) => new Date(date.replaceAll('.', '-')+'Z')

export const getArtifactPath = (tag) => tag.toLowerCase().replace(/[^a-z0-9-]/g, '-')

export const getLatestMeta = async (cwd, tag, basicAuth) => {
  if (!tag) return null

  try {
    const _cwd = await fetchRepo({cwd, branch: 'meta', basicAuth})
    return await Promise.any([
      fs.readJson(path.resolve(_cwd, `${getArtifactPath(tag)}.json`)),
      fs.readJson(path.resolve(_cwd, getArtifactPath(tag), 'meta.json'))
    ])
  } catch {}

  return null
}
