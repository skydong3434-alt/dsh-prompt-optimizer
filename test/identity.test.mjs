/**
 * 独立插件身份迁移测试(id1..id6):v0.3.2-apo 起,运行身份与发布来源统一为
 * `@skydong3434-alt/dsh-prompt-optimizer`(独立 fork 包名),不再沿用上游
 * `@y1x1n/dsh-prompt-optimizer` 包名;package.json version 与 -apo 发行线对齐
 * (0.3.2),不再沿用上游 0.4.0。
 *
 * 覆盖:
 *   id1 package.json name = @skydong3434-alt/dsh-prompt-optimizer,且无旧包名;
 *   id2 package.json version 与发行线对齐(0.3.2),不再沿用上游 0.4.0;
 *   id3 cordis.patch.yml 的插件行 name 与 package.json name 一致(模块解析身份);
 *   id4 构建产物 lib/client.js 的 ModuleLoader id = 包名(宿主按包名 serve 并校验);
 *   id5 lib/ 与 package.json 中无 @y1x1n 运行身份残留(build 已再生);
 *   id6 运行时身份与配置命名空间保持稳定(NS / ROUTE_PATH / SETTINGS_ENTRY_ID),
 *       保证旧配置(profile settings 与客户端设置)无损迁移。
 *
 * 运行:先 `npm run build`,再 `node test/identity.test.mjs`。
 * 本文件场景全部为本项目独立撰写,未复制任何 AGPL 项目(linshenkx / zhangjiazhi)的
 * 源码 / 模板 / 测试。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NEW_NAME = '@skydong3434-alt/dsh-prompt-optimizer'
const OLD_NAME = '@y1x1n/dsh-prompt-optimizer'

// ─────────────────────────────────────────────────────────────────────────────
// id1. 包名身份
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(pkg.name, NEW_NAME, `package.json name 必须是 ${NEW_NAME}`)
  const lock = readFileSync(join(ROOT, 'package-lock.json'), 'utf8')
  assert.ok(!lock.includes(OLD_NAME), 'package-lock.json 不得残留旧包名')
  assert.ok(!JSON.stringify(pkg).includes(OLD_NAME), 'package.json 不得残留旧包名')
  console.log(`✓ id1 包名 = ${NEW_NAME},无旧包名残留`)
}

// ─────────────────────────────────────────────────────────────────────────────
// id2. 版本策略:与 -apo 发行线对齐(不再沿用上游 0.4.0)
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(pkg.version, '0.3.2', 'package.json version 必须对齐 v0.3.2-apo 发行线')
  assert.match(pkg.version, /^0\.3\.\d+$/, '版本必须是 0.3.x 发行线语义化版本')
  console.log(`✓ id2 version = ${pkg.version}(发行线对齐,独立包名后不再沿用上游 0.4.0)`)
}

// ─────────────────────────────────────────────────────────────────────────────
// id3. cordis.patch.yml 插件行与包名一致
// ─────────────────────────────────────────────────────────────────────────────
{
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(`name: '${NEW_NAME}'`), 'cordis.patch.yml 插件行 name 必须指向新包名')
  assert.ok(!patch.includes(OLD_NAME), 'cordis.patch.yml 不得残留旧包名')
  console.log('✓ id3 cordis.patch.yml 插件行 name = 包名(profile node_modules 按此解析)')
}

// ─────────────────────────────────────────────────────────────────────────────
// id4. 构建产物 Client ModuleLoader id = 包名
// ─────────────────────────────────────────────────────────────────────────────
{
  const client = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  assert.match(
    client,
    /window\.__ModuleLoader__\.load\(\{\s*id:\s*"@skydong3434-alt\/dsh-prompt-optimizer"/,
    'lib/client.js 的 ModuleLoader id 必须是新包名(宿主按包名 serve bundle 并校验注册 id)',
  )
  console.log('✓ id4 lib/client.js ModuleLoader id = 新包名')
}

// ─────────────────────────────────────────────────────────────────────────────
// id5. lib/ 运行身份无旧包名残留
// ─────────────────────────────────────────────────────────────────────────────
{
  const built = ['lib/index.js', 'lib/client.js', 'lib/prompt.js', 'lib/controller.js', 'lib/core/v3.js']
  for (const f of built) {
    assert.ok(existsSync(join(ROOT, f)), `构建产物缺失:${f}(先 npm run build)`)
    const text = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(!text.includes(OLD_NAME), `${f} 不得残留旧包名运行身份`)
  }
  console.log('✓ id5 全部构建产物无旧包名运行身份残留')
}

// ─────────────────────────────────────────────────────────────────────────────
// id6. 运行时身份 / 配置命名空间稳定(配置迁移不变式)
// ─────────────────────────────────────────────────────────────────────────────
{
  const host = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')
  const client = readFileSync(join(ROOT, 'src/client/index.tsx'), 'utf8')
  assert.match(host, /const NS\s*=\s*'prompt-optimizer'/, 'Host 配置命名空间 NS 必须保持 prompt-optimizer(旧配置迁移不变式)')
  assert.match(host, /const ROUTE_PATH\s*=\s*'\/dsh-prompt-optimizer\/optimize'/, 'Host 路由路径必须保持(客户端相对调用不变式)')
  assert.match(client, /export const name\s*=\s*'dsh-prompt-optimizer-client'/, 'Client 运行时名必须保持(客户端设置命名空间迁移不变式)')
  assert.match(client, /const SETTINGS_ENTRY_ID\s*=\s*'prompt-optimizer'/, '设置槽位 entry id 必须保持(设置页迁移不变式)')
  console.log('✓ id6 运行时身份与配置命名空间稳定(NS/ROUTE/SETTINGS_ENTRY_ID 未变,配置可迁移)')
}

console.log('\nidentity: all passed')