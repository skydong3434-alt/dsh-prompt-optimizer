#!/usr/bin/env node
/**
 * check-dod —— DoD（PLAN-v1 §18）机器子集自动核对（P09-T02 发布必备门禁）。
 *
 * 只核对「机器可自动断言」的部分；标注 HUMAN 的条目（DoD 终检由用户声明 PASS）
 * 不在本脚本范围内（见 docs/dod.md）。
 *
 * 核对项：
 *   1. 发布交付物存在性：CHANGELOG.md / NOTICE.md / docs/dod.md / LICENSE / README 三件；
 *   2. annotated tag v0.2.0-apo 存在（git tag -a；轻量 tag 会告警 FAIL）；
 *   3. AGPL 污染检查脚本存在且可运行（校验依赖不发散）；
 *   4. 回归证据：schema/runner/报告存档（round7 官方主报告）与 14 例 fixtures 存在；
 *   5. core 契约文件与策略注册表存在（DoD-2/3/4 的代码对象）；
 *   6. NOTICE 声明与本项目元信息一致（v0.2.0-apo 出现于 NOTICE/CHANGELOG/README）。
 *
 * 退出码：0 = 全 PASS；1 = 存在 FAIL。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'v0.2.0-apo';

const fails = [];
const passes = [];

function check(desc, ok, detail = '') {
  if (ok) passes.push(desc + (detail ? `  (${detail})` : ''));
  else fails.push(desc + (detail ? `  (${detail})` : ''));
}

function rel(p) {
  return join(ROOT, p);
}

// ---- 1. 发布交付物存在性 ----
const mustExist = [
  'CHANGELOG.md',
  'NOTICE.md',
  'docs/dod.md',
  'LICENSE',
  'README.md',
  'README.en.md',
  'README.simple.md',
  'scripts/check-license-contamination.mjs',
  'tasks/P09-T02-release-finalize.md',
];
for (const f of mustExist) check(`交付物存在: ${f}`, existsSync(rel(f)));

// ---- 2. annotated tag v0.2.0-apo ----
try {
  const tags = execFileSync('git', ['tag', '-l', VERSION], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (tags.length === 0) {
    check('annotated tag v0.2.0-apo', false, 'tag 不存在');
  } else {
    const type = execFileSync('git', ['cat-file', '-t', VERSION], { cwd: ROOT, encoding: 'utf8' }).trim();
    check('annotated tag v0.2.0-apo', type === 'tag', `类型=${type}`);
  }
} catch {
  check('annotated tag v0.2.0-apo', false, 'git 查询失败');
}

// ---- 3. AGPL 污染检查可运行 ----
try {
  const out = execFileSync('node', ['scripts/check-license-contamination.mjs'], { cwd: ROOT, encoding: 'utf8' });
  check('污染检查可运行且 PASS', /PASS/.test(out), `exit=0`);
} catch {
  check('污染检查可运行且 PASS', false, '脚本执行失败或命中特征串');
}

// ---- 4. 回归证据 ----
const fixtureDir = rel('test/regression/fixtures');
const fixtures = existsSync(fixtureDir) ? readdirSync(fixtureDir).filter((f) => f.endsWith('.json')) : [];
check('语料 fixtures 存在（14 例）', fixtures.length >= 14, `${fixtures.length} 例`);
for (const f of [
  'test/regression/schema.test.mjs',
  'test/regression/run.mjs',
  'test/regression/run.test.mjs',
  'test/regression/report-2026-10-04-round7.json',
  'test/provenance.test.mjs',
  'test/validate.test.mjs',
]) {
  check(`回归/校验证据存在: ${f}`, existsSync(rel(f)));
}

// ---- 5. core 契约 / 策略对象 ----
for (const f of [
  'src/core/types.ts',
  'src/core/provenance.ts',
  'src/core/registry.ts',
  'src/core/compiler.ts',
  'src/core/validate.ts',
  'src/core/classify.ts',
]) {
  check(`core 契约存在: ${f}`, existsSync(rel(f)));
}
const strategies = ['research', 'planning', 'execution', 'diagnostic', 'review', 'creative', 'general'];
for (const s of strategies) {
  check(`策略文件存在: ${s}.ts`, existsSync(rel(`src/core/strategies/${s}.ts`)));
  check(`策略测试存在: strategies-${s}.test.mjs`, existsSync(rel(`test/strategies-${s}.test.mjs`)));
}

// ---- 6. 版本一致性（文艺档自洽）----
const checkVersionIn = (f, label) => {
  if (!existsSync(rel(f))) return;
  const text = readFileSync(rel(f), 'utf8');
  check(`${label} 提及 ${VERSION}`, text.includes(VERSION));
};
checkVersionIn('NOTICE.md', 'NOTICE 声明版本');
checkVersionIn('CHANGELOG.md', 'CHANGELOG 版本条目');
checkVersionIn('README.md', 'README 版本');
checkVersionIn('README.en.md', 'README.en 版本');
checkVersionIn('docs/dod.md', 'DoD 清单版本');

// ---- 汇总 ----
console.log(`[apo] check-dod  v0.2.0-apo  —  ${passes.length} PASS / ${fails.length} FAIL`);
for (const p of passes) console.log(`  ✓ ${p}`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  console.log('[apo] 结果: FAIL —— DoD 机器子集未全绿，禁止宣布发布就绪。');
  process.exit(1);
}
console.log('[apo] 结果: PASS —— DoD 机器子集全绿；DoD 终检（HUMAN）待用户声明 PASS。');
process.exit(0);