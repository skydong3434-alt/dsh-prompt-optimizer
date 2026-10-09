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

// Core 独立产物:V3 核心、分诊与契约类型(纯函数,零外部依赖),
// 供单元测试与端到端冒烟直接引用(不经过 Host / UI)。
await mkdir('lib/core', { recursive: true })
for (const [entry, outfile] of [
  ['src/core/types.ts', 'lib/core/types.js'],
  ['src/core/triage.ts', 'lib/core/triage.js'],
  ['src/core/v3.ts', 'lib/core/v3.js'],
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

// Client settings 统一读写面:纯逻辑,零 React/DOM 依赖,供单测直接引用。
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
