import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'

await mkdir('lib', { recursive: true })

// 元提示词与输出解析:独立产物,供单元测试(以及潜在的第三方复用)直接引用。
await build({
  entryPoints: ['src/prompt.ts'],
  outfile: 'lib/prompt.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Core 契约层:Provenance 机械校验器,独立 ESM 产物供单元测试直接引用(纯函数,零依赖)。
await mkdir('lib/core', { recursive: true })
await build({
  entryPoints: ['src/core/provenance.ts'],
  outfile: 'lib/core/provenance.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Core 策略层:Research 策略(纯数据 + 纯函数),_shared 随 bundle 内联,
// 独立 ESM 产物供单测直接引用(策略可独立升级/测试,不经过 Host 与 UI)。
await mkdir('lib/core/strategies', { recursive: true })
await build({
  entryPoints: ['src/core/strategies/research.ts'],
  outfile: 'lib/core/strategies/research.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// 共享规则段 / 守卫工厂(_shared):独立 ESM 产物,供 test/strategies-shared.test.mjs
// 单独验证「七策略共用的一份总纲」;research.js 仍各自内联,二者互不影响。
await build({
  entryPoints: ['src/core/strategies/_shared.ts'],
  outfile: 'lib/core/strategies/_shared.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Planning 策略(P02-T02):纯数据 + 纯函数,独立 ESM 产物供单测直接引用;
// _shared 随 bundle 内联(策略可在不经过 Host / UI 的前提下独立升级与测试)。
await build({
  entryPoints: ['src/core/strategies/planning.ts'],
  outfile: 'lib/core/strategies/planning.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Execution 策略(P02-T03):纯数据 + 纯函数,独立 ESM 产物供单测直接引用;
// _shared 随 bundle 内联(策略可在不经过 Host / UI 的前提下独立升级与测试)。
await build({
  entryPoints: ['src/core/strategies/execution.ts'],
  outfile: 'lib/core/strategies/execution.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Diagnostic 策略(P02-T04):纯数据 + 纯函数,独立 ESM 产物供单测直接引用;
// _shared 随 bundle 内联(策略可在不经过 Host / UI 的前提下独立升级与测试)。
await build({
  entryPoints: ['src/core/strategies/diagnostic.ts'],
  outfile: 'lib/core/strategies/diagnostic.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Review 策略(P02-T05):纯数据 + 纯函数,独立 ESM 产物供单测直接引用;
// _shared 随 bundle 内联(策略可在不经过 Host / UI 的前提下独立升级与测试)。
await build({
  entryPoints: ['src/core/strategies/review.ts'],
  outfile: 'lib/core/strategies/review.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Creative 策略(P02-T06):纯数据 + 纯函数,独立 ESM 产物供单测直接引用;
// _shared 随 bundle 内联(策略可在不经过 Host / UI 的前提下独立升级与测试)。
await build({
  entryPoints: ['src/core/strategies/creative.ts'],
  outfile: 'lib/core/strategies/creative.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// General 兜底策略(P02-T07):纯数据 + 纯函数,独立 ESM 产物供单测直接引用;
// _shared 随 bundle 内联(策略可在不经过 Host / UI 的前提下独立升级与测试)。
await build({
  entryPoints: ['src/core/strategies/general.ts'],
  outfile: 'lib/core/strategies/general.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Core 最小管线:context / classify / registry / compiler —— 各自独立 ESM 产物,
// 供纯函数单测与 Vertical Slice 端到端冒烟直接引用。
await build({
  entryPoints: ['src/core/context.ts'],
  outfile: 'lib/core/context.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})
await build({
  entryPoints: ['src/core/classify.ts'],
  outfile: 'lib/core/classify.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})
await build({
  entryPoints: ['src/core/registry.ts'],
  outfile: 'lib/core/registry.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})
await build({
  entryPoints: ['src/core/compiler.ts'],
  outfile: 'lib/core/compiler.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// 输出守卫执行器(validate.ts,P04-T02):三层 anti-drift 机械校验,纯函数,
// 独立 ESM 产物供单测直接引用;compiler / Host 后续按需内联复用。
await build({
  entryPoints: ['src/core/validate.ts'],
  outfile: 'lib/core/validate.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Host 半:ESM;@deepseek-ai/* 与 node 内建模块保持外部,由 profile 的 node_modules 解析。
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Client controller:独立 ESM 产物,供单元测试直接引用(纯逻辑,不依赖 DOM)。
await build({
  entryPoints: ['src/client/controller.ts'],
  outfile: 'lib/controller.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// Client settings 统一读写面(settings-face.ts):纯逻辑,零 React/DOM 依赖,
// 独立 ESM 产物供单测直接引用(验证 0.1.x settingsScope / 0.2.0 configForms 双后端
// 以及新增 promptType / classifierModel 字段的读写与快照缓存)。
await build({
  entryPoints: ['src/client/settings-face.ts'],
  outfile: 'lib/client/settings-face.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  logLevel: 'info',
})

// v2 分析层(targets / triage / requirements / analyze):纯函数 + 表驱动目录,
// 独立 ESM 产物供单测与端到端冒烟直接引用(不经过 Host / UI)。
await mkdir('lib/core', { recursive: true })
for (const [entry, outfile] of [
  ['src/core/types.ts', 'lib/core/types.js'],
  ['src/core/targets.ts', 'lib/core/targets.js'],
  ['src/core/triage.ts', 'lib/core/triage.js'],
  ['src/core/requirements.ts', 'lib/core/requirements.js'],
  ['src/core/analyze.ts', 'lib/core/analyze.js'],
  ['src/core/disposition-render.ts', 'lib/core/disposition-render.js'],
  ['src/core/responsibilities.ts', 'lib/core/responsibilities.js'],
  ['src/core/router.ts', 'lib/core/router.js'],
  ['src/core/discovery.ts', 'lib/core/discovery.js'],
  ['src/core/validation-flow.ts', 'lib/core/validation-flow.js'],
  ['src/core/ledger-reconcile.ts', 'lib/core/ledger-reconcile.js'],
  ['src/core/provenance-recovery.ts', 'lib/core/provenance-recovery.js'],
  ['src/core/strategies/_visual-shared.ts', 'lib/core/strategies/_visual-shared.js'],
  ['src/core/strategies/agent.ts', 'lib/core/strategies/agent.js'],
  ['src/core/strategies/image.ts', 'lib/core/strategies/image.js'],
  ['src/core/strategies/video.ts', 'lib/core/strategies/video.js'],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    packages: 'external',
    logLevel: 'info',
  })
}

// Client 半:loader 的 lazy-CJS factory 形态(对齐官方包的产物结构)。
// react 与 @deepseek-ai/* 是页面运行时外部模块,不打包进 bundle。
// 注意:loader id 必须等于插件 npm 包名 —— 宿主 client-modules 按包名 serve
// bundle 并校验注册 id,不一致会被拒绝(Failed to load plugins,#4)。
// 从 package.json 动态读取,避免改包名时 banner 失同步。
const pkgName = JSON.parse(readFileSync('package.json', 'utf8')).name
const banner = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(pkgName)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
].join('\n')
const footer = ['\t\treturn module.exports;', '\t}', '});'].join('\n')

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/*', '@deepseek-ai/*'],
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
})

console.log('[build] lib/index.js + lib/client.js + lib/prompt.js + lib/controller.js + lib/client/settings-face.js + lib/core/provenance.js + lib/core/context.js + lib/core/classify.js + lib/core/registry.js + lib/core/compiler.js + lib/core/validate.js + lib/core/strategies/_shared.js + lib/core/strategies/research.js + lib/core/strategies/planning.js + lib/core/strategies/execution.js + lib/core/strategies/diagnostic.js + lib/core/strategies/review.js + lib/core/strategies/creative.js + lib/core/strategies/general.js + lib/core/targets.js + lib/core/triage.js + lib/core/requirements.js + lib/core/analyze.js done')
