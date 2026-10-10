#!/usr/bin/env node
/**
 * APO v0.3.2-apo — Desktop profile「独立插件身份」原子迁移 / 回退工具
 *
 * 背景
 * ----
 * 本插件的包名已从 `@y1x1n/dsh-prompt-optimizer`(上游派生名)迁移为独立身份
 * `@skydong3434-alt/dsh-prompt-optimizer`。DSH Desktop 宿主在 prepareDesktopProfile
 * 阶段用 readCandidate() 校验:
 *
 *     manifest.name === <profile package.json 里 dependencies 的键>
 *
 * 不一致时抛 `dsh-plugin-desktop: profile package identity is invalid for <name>`
 * 并终止启动(发生在插件加载之前,所以和插件代码无关)。
 *
 * 官方 CLI 拒绝管理 desktop profile:
 *     error: profile "desktop" is managed exclusively by the Electron application
 * 因此本工具以最小、可备份、可回退的方式直接改这 5 处:
 *   1) profile package.json 的 dependencies 键(旧键退出 / 新键指向本仓库)
 *   2) profile package.json 的 dsh.profile.bundles(启用列表,新名必须在内)
 *   3) profile package.json 的 dsh.desktopDeselectedBundles(取消启用记录,旧名必须移除)
 *   4) node_modules 下新旧包名的软链
 *   5) pnpm 元数据中的旧键(pnpm-lock.yaml / node_modules/.pnpm/lock.yaml /
 *      node_modules/.package-map.json)
 *
 * 用法(必须在**退出 DSH Desktop 之后**、从系统终端运行)
 * ----------------------------------------------------
 *   node scripts/migrate-desktop-identity.mjs --check
 *       只读体检:报告当前状态与将要执行的改动,不改任何文件。
 *   node scripts/migrate-desktop-identity.mjs
 *       执行迁移:先备份 → 逐步修改 → 逐步校验;任一步失败自动回滚。
 *   node scripts/migrate-desktop-identity.mjs --rollback <备份目录>
 *       用备份回退到迁移前的状态。
 *
 * 安全约束
 * --------
 * - 不使用任何 git 命令(尤其没有 reset --hard / clean / checkout)。
 * - 只改上面列出的 5 处;不碰其它插件、不删用户设置、不动 cordis.patch.yml。
 * - 幂等:已处于目标状态时不做任何写入。
 * - DSH Desktop 正在运行时拒绝执行(--check 除外),避免半迁移状态被宿主读到。
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DSH_HOME = join(homedir(), '.dsh')
/** 备份根目录;测试可用 APO_BACKUP_ROOT 覆盖,避免污染真实备份目录。 */
const BACKUP_ROOT = process.env.APO_BACKUP_ROOT ? resolve(process.env.APO_BACKUP_ROOT) : join(DSH_HOME, 'backups')
const OLD_NAME = '@y1x1n/dsh-prompt-optimizer'
/** 新身份直接取自本仓库 package.json,保证「迁移目标」与「构建产物」不可能不一致。 */
const NEW_NAME = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).name

/** pnpm 元数据里可能残留旧键的文件(相对 profile 目录)。 */
const META_FILES = [
  'pnpm-lock.yaml',
  'node_modules/.pnpm/lock.yaml',
  'node_modules/.package-map.json',
  'node_modules/.modules.yaml',
]

// ---------------------------------------------------------------- 参数解析

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''))
  process.exit(0)
}

const PROFILE = resolve(option('--profile-dir') ?? join(DSH_HOME, 'profiles', 'desktop'))
const NM = join(PROFILE, 'node_modules')
const PKG_PATH = join(PROFILE, 'package.json')
const CHECK_ONLY = flag('--check')
const FORCE = flag('--force')
const ROLLBACK_FROM = option('--rollback')

// ---------------------------------------------------------------- 输出helper

let failures = 0
const log = (msg = '') => console.log(msg)
const step = (msg) => console.log(`\n▶ ${msg}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const info = (msg) => console.log(`    ${msg}`)
const warn = (msg) => console.log(`  ! ${msg}`)
const bad = (msg) => {
  failures += 1
  console.log(`  ✗ ${msg}`)
}

function die(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------- 基础读取

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function detectIndent(raw) {
  const m = raw.match(/^\{\r?\n([ \t]+)"/)
  return m ? m[1] : '  '
}

function writeJson(path, value, indent) {
  const text = `${JSON.stringify(value, null, indent)}\n`
  writeFileSync(path, text, 'utf8')
  return text
}

/**
 * 路径是否存在(含**悬空软链**)。
 * `existsSync` 会跟随软链,对指向不存在目标的软链返回 false,
 * 清理软链时若用它就会漏删 → 这里统一用 lstat。
 */
function lexists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** 读取软链状态;不存在的返回 {exists:false}。 */
function linkState(name) {
  const path = join(NM, name)
  let exists = false
  try {
    lstatSync(path)
    exists = true
  } catch {
    exists = false
  }
  if (!exists) return { name, path, exists: false, target: null, resolvesToRepo: false }
  const target = readlinkSync(path)
  let resolvesToRepo = false
  try {
    resolvesToRepo = resolve(dirname(path), target) === REPO
  } catch {
    resolvesToRepo = false
  }
  return { name, path, exists: true, target, resolvesToRepo }
}

/**
 * DSH Desktop 是否在运行。
 * 注意:macOS 的 `pgrep -f` 对本机 Electron 主进程不可靠(实测漏报),
 * 因此改用 `ps -Ao pid,command` + 子串匹配。
 */
function isDshRunning() {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' })
    return out
      .split('\n')
      .filter((line) => line.includes('DSH Desktop.app/Contents/'))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean)
  } catch {
    return []
  }
}

function gitHead() {
  try {
    return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function countIn(path, needle) {
  if (!existsSync(path)) return 0
  const text = readFileSync(path, 'utf8')
  return text.split(needle).length - 1
}

// ---------------------------------------------------------------- 状态快照

function snapshot() {
  const raw = readFileSync(PKG_PATH, 'utf8')
  const pkg = JSON.parse(raw)
  const bundles = pkg.dsh?.profile?.bundles ?? []
  const deselected = pkg.dsh?.desktopDeselectedBundles ?? []
  return {
    raw,
    indent: detectIndent(raw),
    pkg,
    bundles,
    deselected,
    depOld: pkg.dependencies?.[OLD_NAME],
    depNew: pkg.dependencies?.[NEW_NAME],
    bundleHasOld: bundles.includes(OLD_NAME),
    bundleHasNew: bundles.includes(NEW_NAME),
    deselectedHasOld: deselected.includes(OLD_NAME),
    deselectedHasNew: deselected.includes(NEW_NAME),
    linkOld: linkState(OLD_NAME),
    linkNew: linkState(NEW_NAME),
    metaOldCounts: META_FILES.map((rel) => [rel, countIn(join(PROFILE, rel), OLD_NAME)]),
  }
}

/** 目标状态是否已经全部满足(用于幂等)。 */
function isDone(s) {
  return (
    !s.depOld &&
    s.depNew === `link:${REPO}` &&
    s.bundleHasNew &&
    !s.bundleHasOld &&
    !s.deselectedHasOld &&
    !s.deselectedHasNew &&
    s.linkNew.exists &&
    s.linkNew.resolvesToRepo &&
    !s.linkOld.exists &&
    s.metaOldCounts.every(([, n]) => n === 0)
  )
}

// ---------------------------------------------------------------- 前置检查

function preflight() {
  step('前置检查')

  const repoPkg = existsSync(join(REPO, 'package.json')) ? readJson(join(REPO, 'package.json')) : null
  if (!repoPkg) die(`找不到仓库 package.json:${REPO}`)
  if (repoPkg.name !== NEW_NAME) die(`仓库包名异常:${repoPkg.name}`)
  ok(`本仓库身份 = ${NEW_NAME} (version ${repoPkg.version})`)

  for (const entry of ['lib/index.js', 'lib/client.js']) {
    if (!existsSync(join(REPO, entry))) die(`构建产物缺失:${entry}(请先 npm run build)`)
  }
  const clientBundle = readFileSync(join(REPO, 'lib/client.js'), 'utf8')
  if (!clientBundle.includes(NEW_NAME)) die('lib/client.js 未包含新包名,请先重新构建(npm run build)')
  ok('构建产物存在且带新包名身份')

  if (!existsSync(PKG_PATH)) die(`找不到 desktop profile:${PKG_PATH}`)
  ok(`目标 profile = ${PROFILE}`)

  const procs = isDshRunning()
  if (procs.length) {
    if (CHECK_ONLY || FORCE) {
      warn(`DSH Desktop 正在运行(pid ${procs.join(', ')});${CHECK_ONLY ? '只读体检' : '--force 已指定'},继续`)
    } else {
      die(
        'DSH Desktop 正在运行。请先完全退出 DSH Desktop,再从系统终端重新运行本命令。\n' +
          '  (迁移必须在宿主未运行时完成,否则可能读到半迁移状态。)',
      )
    }
  } else {
    ok('DSH Desktop 未在运行')
  }
}

// ---------------------------------------------------------------- 备份

function makeBackup(s) {
  step('备份')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  const dir = join(BACKUP_ROOT, `desktop-identity-${stamp}`)
  mkdirSync(dir, { recursive: true })

  const files = []
  for (const rel of ['package.json', ...META_FILES]) {
    const src = join(PROFILE, rel)
    if (!existsSync(src)) continue
    const dest = join(dir, rel.replace(/\//g, '__'))
    copyFileSync(src, dest)
    files.push({ rel, backup: basename(dest) })
  }

  const manifest = {
    tool: 'scripts/migrate-desktop-identity.mjs',
    createdAt: new Date().toISOString(),
    repo: REPO,
    repoHead: gitHead(),
    profile: PROFILE,
    oldName: OLD_NAME,
    newName: NEW_NAME,
    before: {
      dependenciesOld: s.depOld ?? null,
      dependenciesNew: s.depNew ?? null,
      bundles: s.bundles,
      desktopDeselectedBundles: s.deselected,
      linkOld: s.linkOld.exists ? s.linkOld.target : null,
      linkNew: s.linkNew.exists ? s.linkNew.target : null,
    },
    files,
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  ok(`备份目录:${dir}`)
  info(`已备份 ${files.length} 个文件 + manifest.json`)
  return dir
}

// ---------------------------------------------------------------- 迁移

function applyPlan(s) {
  step('迁移(逐步执行并校验)')

  const pkg = JSON.parse(s.raw)
  pkg.dependencies = pkg.dependencies ?? {}
  delete pkg.dependencies[OLD_NAME]
  pkg.dependencies[NEW_NAME] = `link:${REPO}`
  ok(`dependencies:${OLD_NAME} → ${NEW_NAME}`)

  const profile = (pkg.dsh = pkg.dsh ?? {})
  profile.profile = profile.profile ?? {}
  const bundles = (profile.profile.bundles = profile.profile.bundles ?? [])
  const filtered = bundles.filter((b) => b !== OLD_NAME)
  if (!filtered.includes(NEW_NAME)) filtered.push(NEW_NAME)
  profile.profile.bundles = filtered
  ok(`dsh.profile.bundles:加入 ${NEW_NAME}(位于末尾,保持其它插件相对顺序不变)`)

  const deselected = (profile.desktopDeselectedBundles = profile.desktopDeselectedBundles ?? []).filter(
    (b) => b !== OLD_NAME && b !== NEW_NAME,
  )
  profile.desktopDeselectedBundles = deselected
  ok('dsh.desktopDeselectedBundles:移除旧名(插件重新启用)')

  writeJson(PKG_PATH, pkg, s.indent)
  ok('package.json 已写入')

  const linkDir = join(NM, NEW_NAME.split('/')[0])
  mkdirSync(linkDir, { recursive: true })
  const linkPath = join(NM, NEW_NAME)
  if (lexists(linkPath)) unlinkSync(linkPath)
  symlinkSync(relative(dirname(linkPath), REPO), linkPath)
  ok(`软链:${NEW_NAME} → ${relative(dirname(linkPath), REPO)}`)

  if (s.linkOld.exists) {
    if (!s.linkOld.resolvesToRepo) {
      warn(`${OLD_NAME} 软链未指向本仓库(${s.linkOld.target}),保守起见保留不动`)
    } else {
      unlinkSync(s.linkOld.path)
      ok(`软链:移除旧名 ${OLD_NAME}`)
      const oldDir = join(NM, OLD_NAME.split('/')[0])
      if (existsSync(oldDir) && readdirSync(oldDir).length === 0) {
        rmSync(oldDir, { recursive: true })
        ok('清理空的 @y1x1n/ 目录')
      }
    }
  }

  for (const rel of META_FILES) {
    const path = join(PROFILE, rel)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    if (!text.includes(OLD_NAME)) continue
    writeFileSync(path, text.split(OLD_NAME).join(NEW_NAME), 'utf8')
    ok(`元数据:${rel} 旧键 → 新键`)
  }
}

function verify() {
  step('迁移后校验')
  const s = snapshot()

  const checks = [
    ['旧依赖键已移除', !s.depOld],
    ['新依赖键指向本仓库', s.depNew === `link:${REPO}`],
    ['dsh.profile.bundles 含新名', s.bundleHasNew],
    ['dsh.profile.bundles 不含旧名', !s.bundleHasOld],
    ['desktopDeselectedBundles 已清空旧名', !s.deselectedHasOld],
    ['新包名软链存在且指向本仓库', s.linkNew.exists && s.linkNew.resolvesToRepo],
    ['旧包名软链已移除', !s.linkOld.exists],
    ['pnpm 元数据无旧名残留', s.metaOldCounts.every(([, n]) => n === 0)],
    ['profile 依赖键 == 本仓库 package.json name', readJson(join(REPO, 'package.json')).name === NEW_NAME],
  ]
  for (const [label, pass] of checks) (pass ? ok : bad)(label)

  const name = s.pkg.name
  if (!name) bad('profile package.json 缺少 name')
  for (const [, n] of s.metaOldCounts) if (n > 0) info('仍有旧名残留的元数据文件见上')

  return failures === 0
}

// ---------------------------------------------------------------- 回退

function rollback(dir) {
  step(`回退(备份目录 ${dir})`)
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) die(`备份目录缺少 manifest.json:${dir}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  for (const { rel, backup } of manifest.files) {
    const src = join(dir, backup)
    if (!existsSync(src)) {
      warn(`备份文件缺失,跳过:${rel}`)
      continue
    }
    copyFileSync(src, join(PROFILE, rel))
    ok(`已还原 ${rel}`)
  }

  const before = manifest.before ?? {}
  // 还原软链:先移除新名,再按备份重建旧名
  const newPath = join(NM, manifest.newName)
  if (lexists(newPath)) {
    unlinkSync(newPath)
    ok(`已移除软链 ${manifest.newName}`)
  }
  const newDir = join(NM, manifest.newName.split('/')[0])
  if (existsSync(newDir) && readdirSync(newDir).length === 0) rmSync(newDir, { recursive: true })

  if (before.linkOld) {
    const oldPath = join(NM, manifest.oldName)
    const oldDir = join(NM, manifest.oldName.split('/')[0])
    mkdirSync(oldDir, { recursive: true })
    if (lexists(oldPath)) unlinkSync(oldPath)
    symlinkSync(before.linkOld, oldPath)
    ok(`已重建软链 ${manifest.oldName} → ${before.linkOld}`)
  }

  const s = snapshot()
  const back =
    (before.dependenciesOld ? s.depOld === before.dependenciesOld : !s.depOld) &&
    JSON.stringify(s.bundles) === JSON.stringify(before.bundles ?? s.bundles) &&
    JSON.stringify(s.deselected) === JSON.stringify(before.desktopDeselectedBundles ?? s.deselected)
  if (back) ok('回退后状态与备份记录一致')
  else bad('回退后状态与备份记录不一致,请人工检查')

  return failures === 0
}

// ---------------------------------------------------------------- main

const NEW_NAME_FROM_REPO = existsSync(join(REPO, 'package.json')) ? readJson(join(REPO, 'package.json')).name : null
if (!NEW_NAME_FROM_REPO) die(`找不到仓库 package.json:${REPO}`)

log('=== APO Desktop profile 独立插件身份迁移工具 ===')
log(`仓库:${REPO}`)
log(`目标 profile:${PROFILE}`)

if (ROLLBACK_FROM) {
  const good = rollback(resolve(ROLLBACK_FROM))
  log(`\n=== 回退结果:${good ? '完成' : '有失败项,请人工检查'} ===`)
  process.exit(good ? 0 : 1)
}

preflight()
const before = snapshot()

step('当前状态')
info(`profile name        : ${before.pkg.name}`)
info(`dependencies 旧键   : ${before.depOld ?? '(无)'}`)
info(`dependencies 新键   : ${before.depNew ?? '(无)'}`)
info(`bundles 含旧/新     : ${before.bundleHasOld} / ${before.bundleHasNew}`)
info(`deselected 旧/新    : ${before.deselectedHasOld} / ${before.deselectedHasNew}`)
info(`软链旧名            : ${before.linkOld.exists ? before.linkOld.target : '(无)'}`)
info(`软链新名            : ${before.linkNew.exists ? before.linkNew.target : '(无)'}`)
info(`元数据旧名残留      : ${before.metaOldCounts.map(([f, n]) => `${f}=${n}`).join(', ')}`)

if (isDone(before)) {
  log('\n=== 已处于目标状态,无需迁移 ===')
  process.exit(0)
}

if (CHECK_ONLY) {
  log('\n=== 只读体检完成(未修改任何文件)===')
  log('去掉 --check 即可执行迁移。')
  process.exit(0)
}

const backupDir = makeBackup(before)
try {
  applyPlan(before)
  const good = verify()
  if (!good) throw new Error('校验未通过')
} catch (err) {
  console.error(`\n✗ 迁移失败:${err?.message ?? err}`)
  console.error(`  正在用备份回退:${backupDir}`)
  rollback(backupDir)
  console.error('\n✗ 已回退到迁移前状态。Desktop 应保持可用(APO 仍按旧身份)。')
  process.exit(1)
}

log('\n=== 迁移完成 ===')
log('下一步:')
log('  1) 重新启动 DSH Desktop')
log('  2) 设置 → 插件列表应显示 @skydong3434-alt/dsh-prompt-optimizer,且只有一份 APO')
log('  3) 设置 → 提示词优化 卡片应能打开(不再报 slot "settings.plugin.item" is not declared)')
log('  4) 输入框应只有一个「优化」按钮,点击能正常调用当前会话模型')
log('')
log('如需回退,运行:')
log(`  node "${fileURLToPath(import.meta.url)}" --rollback "${backupDir}"`)
