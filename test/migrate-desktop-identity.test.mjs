/**
 * Desktop profile 独立插件身份迁移工具回归测试(mg1..mg6)
 *
 * 被测对象:`scripts/migrate-desktop-identity.mjs`
 * 这是 DSH Desktop 启动故障(v0.3.2-apo 身份迁移后
 * `profile package identity is invalid for @y1x1n/dsh-prompt-optimizer`)的恢复工具,
 * 它必须在**真实 profile 之外**可完整验证,否则「交给用户执行」的迁移步骤没有依据。
 *
 * 本测试在系统临时目录里构造一份**合成 profile 副本**(不读取、不修改真实
 * `~/.dsh/profiles/desktop`),覆盖:
 *   mg1 --check 是只读的(不修改任何文件);
 *   mg2 迁移后 profile 依赖键 / bundles / desktopDeselectedBundles 三处一致(启用机制正确);
 *   mg3 迁移后新旧包名软链正确(新名指向本仓库、旧名移除、空目录清理);
 *   mg4 迁移后 pnpm 元数据无旧包名残留;
 *   mg5 幂等:重复执行不产生任何写入;
 *   mg6 回退:package.json 逐字节还原、软链状态还原。
 *
 * 运行:先 `npm run build`,再 `node test/migrate-desktop-identity.test.mjs`。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts/migrate-desktop-identity.mjs')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NEW_NAME = pkg.name
const OLD_NAME = '@y1x1n/dsh-prompt-optimizer'
const OTHER_DEP = 'some-other-plugin'

const WORK = join(tmpdir(), `apo-migrate-test-${process.pid}`)
const FIXTURE = join(WORK, 'desktop')
const BACKUPS = join(WORK, 'backups')

function lexists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** 构造合成 profile:只有旧身份 + 一个无关插件(用于验证「不碰其它插件」)。 */
function buildFixture() {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(join(FIXTURE, 'node_modules/@y1x1n'), { recursive: true })
  mkdirSync(join(FIXTURE, 'node_modules/.pnpm'), { recursive: true })
  mkdirSync(BACKUPS, { recursive: true })

  const profile = {
    name: 'dsh-profile-test',
    private: true,
    dependencies: { [OLD_NAME]: `link:${ROOT}`, [OTHER_DEP]: '1.0.0' },
    dsh: {
      profile: { bundles: ['@deepseek-ai/dsh-base', OTHER_DEP], patchReload: 'live' },
      desktopDeselectedBundles: [OLD_NAME],
    },
  }
  writeFileSync(join(FIXTURE, 'package.json'), `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(FIXTURE, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '${OLD_NAME}':\n        specifier: link:${ROOT}\n        version: link:../../../Projects/x\n      ${OTHER_DEP}:\n        specifier: 1.0.0\n        version: 1.0.0\n`,
    'utf8',
  )
  writeFileSync(join(FIXTURE, 'node_modules/.pnpm/lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '${OLD_NAME}':\n        specifier: link:${ROOT}\n`, 'utf8')
  writeFileSync(join(FIXTURE, 'node_modules/.package-map.json'), JSON.stringify({ [OLD_NAME]: '../../../../x', [OTHER_DEP]: OTHER_DEP }), 'utf8')
  writeFileSync(join(FIXTURE, 'node_modules/.modules.yaml'), 'hoistPattern:\n  - "*"\n', 'utf8')
  symlinkSync(ROOT, join(FIXTURE, 'node_modules/@y1x1n/dsh-prompt-optimizer'))
  return `${JSON.stringify(profile, null, 2)}\n`
}

/** 运行迁移工具;返回 {code, out}。--force 让测试在 DSH 正在运行的机器上也能跑。 */
function run(args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--profile-dir', FIXTURE, ...args], {
      encoding: 'utf8',
      env: { ...process.env, APO_BACKUP_ROOT: BACKUPS },
    })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const readProfile = () => JSON.parse(readFileSync(join(FIXTURE, 'package.json'), 'utf8'))
const readAll = (...rel) => readFileSync(join(FIXTURE, ...rel), 'utf8')

try {
  const initial = buildFixture()

  // ───────────────────────────────────────────────────────────────────────────
  // mg1. --check 只读
  // ───────────────────────────────────────────────────────────────────────────
  {
    const { code, out } = run(['--check', '--force'])
    assert.equal(code, 0, `--check 必须成功退出:\n${out}`)
    assert.ok(out.includes('只读体检完成'), '--check 应报告只读体检完成')
    assert.equal(readFileSync(join(FIXTURE, 'package.json'), 'utf8'), initial, '--check 不得修改 package.json')
    assert.ok(!lexists(join(FIXTURE, 'node_modules', NEW_NAME)), '--check 不得创建新软链')
    console.log('✓ mg1 --check 只读:不修改 profile、不创建软链')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // mg2..mg4. 迁移
  // ───────────────────────────────────────────────────────────────────────────
  let backupDir = null
  {
    const { code, out } = run(['--force'])
    assert.equal(code, 0, `迁移必须成功:\n${out}`)
    assert.ok(out.includes('迁移完成'), '迁移应报告完成')
    const m = out.match(/备份目录:(\S+)/)
    assert.ok(m, '迁移应报告备份目录')
    backupDir = m[1]
    assert.ok(existsSync(join(backupDir, 'manifest.json')), '备份目录必须含 manifest.json')
    assert.ok(existsSync(join(backupDir, 'package.json')), '备份目录必须含 package.json 备份')

    const after = readProfile()
    // mg2 profile 三处一致
    assert.equal(after.dependencies[OLD_NAME], undefined, '旧依赖键必须移除')
    assert.equal(after.dependencies[NEW_NAME], `link:${ROOT}`, '新依赖键必须指向本仓库')
    assert.equal(after.dependencies[OTHER_DEP], '1.0.0', '不得改动其它插件依赖')
    assert.ok(after.dsh.profile.bundles.includes(NEW_NAME), '新包名必须进入 bundles(启用列表)')
    assert.ok(!after.dsh.profile.bundles.includes(OLD_NAME), '旧包名必须离开 bundles')
    assert.deepEqual(after.dsh.profile.bundles.filter((b) => b === OTHER_DEP), [OTHER_DEP], '不得改动其它插件在 bundles 中的位置')
    assert.deepEqual(after.dsh.desktopDeselectedBundles, [], '旧包名必须从 desktopDeselectedBundles 移除(重新启用)')
    console.log('✓ mg2 依赖键 / bundles / desktopDeselectedBundles 三处一致(插件重新启用)')

    // mg3 软链
    const newLink = join(FIXTURE, 'node_modules', NEW_NAME)
    assert.ok(lexists(newLink), '新包名软链必须存在')
    assert.equal(
      resolve(dirname(newLink), readlinkSync(newLink)),
      ROOT,
      '新软链必须解析到本仓库(测试目录深度不同,故比较解析结果而非读取文件)',
    )
    assert.ok(!lexists(join(FIXTURE, 'node_modules/@y1x1n/dsh-prompt-optimizer')), '旧包名软链必须移除')
    assert.ok(!existsSync(join(FIXTURE, 'node_modules/@y1x1n')), '空的 @y1x1n 目录必须清理')
    console.log('✓ mg3 新软链指向本仓库、旧软链与空目录已清理')

    // mg4 pnpm 元数据
    for (const rel of ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml', 'node_modules/.package-map.json']) {
      const text = readAll(...rel.split('/'))
      assert.ok(!text.includes(OLD_NAME), `${rel} 不得残留旧包名`)
      assert.ok(text.includes(NEW_NAME), `${rel} 应写入新包名`)
      assert.ok(text.includes(OTHER_DEP) || rel === 'node_modules/.pnpm/lock.yaml', `${rel} 不得丢失其它条目`)
    }
    console.log('✓ mg4 pnpm 元数据旧键已替换为新键,其它条目保留')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // mg5. 幂等
  // ───────────────────────────────────────────────────────────────────────────
  {
    const before = readFileSync(join(FIXTURE, 'package.json'), 'utf8')
    const { code, out } = run(['--force'])
    assert.equal(code, 0, `重复执行必须成功退出:\n${out}`)
    assert.ok(out.includes('已处于目标状态'), '重复执行应报告已处于目标状态')
    assert.equal(readFileSync(join(FIXTURE, 'package.json'), 'utf8'), before, '重复执行不得重写 package.json')
    console.log('✓ mg5 幂等:重复执行零写入')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // mg6. 回退
  // ───────────────────────────────────────────────────────────────────────────
  {
    const { code, out } = run(['--rollback', backupDir])
    assert.equal(code, 0, `回退必须成功:\n${out}`)
    assert.ok(out.includes('回退后状态与备份记录一致'), '回退应报告状态一致')
    assert.equal(readFileSync(join(FIXTURE, 'package.json'), 'utf8'), initial, '回退后 package.json 必须逐字节还原')
    assert.ok(lexists(join(FIXTURE, 'node_modules/@y1x1n/dsh-prompt-optimizer')), '回退后旧软链必须重建')
    assert.ok(!lexists(join(FIXTURE, 'node_modules', NEW_NAME)), '回退后新软链必须移除')
    assert.ok(readAll('pnpm-lock.yaml').includes(OLD_NAME), '回退后 pnpm 元数据应还原旧键')
    console.log('✓ mg6 回退:package.json 逐字节还原、软链与元数据还原')
  }
} finally {
  rmSync(WORK, { recursive: true, force: true })
}

console.log('\nmigrate-desktop-identity: all passed')
