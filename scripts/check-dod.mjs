#!/usr/bin/env node
/**
 * check-dod —— DoD（PLAN-v1 §18）机器子集自动核对（P09-T02 发布必备门禁）。
 *
 * 只核对「机器可自动断言」的部分；标注 HUMAN 的条目（DoD 终检由用户声明 PASS）
 * 不在本脚本范围内（见 docs/dod.md）。
 *
 * 核对项：
 *   1. 发布交付物存在性：CHANGELOG.md / NOTICE.md / docs/dod.md / LICENSE / README 三件；
 *   2. annotated tag v0.3.1-apo 存在（git tag -a；轻量 tag 会告警 FAIL）；
 *   3. AGPL 污染检查脚本存在且可运行（校验依赖不发散）；
 *   4. V3 回归证据：test/v3.test.mjs、test/smoke.mjs、scripts/v3-real-check.mjs 存在；
 *   5. V3 单架构不变式：V3 契约文件存在，且旧链路文件必须不存在；
 *   6. NOTICE 声明与本项目元信息一致（v0.3.1-apo 出现于 NOTICE/CHANGELOG/README）。
 *
 * 退出码：0 = 全 PASS；1 = 存在 FAIL。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'v0.3.1-apo';

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

// ---- 2. annotated tag v0.3.1-apo ----
try {
  const tags = execFileSync('git', ['tag', '-l', VERSION], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (tags.length === 0) {
    check('annotated tag v0.3.1-apo', false, 'tag 不存在');
  } else {
    const type = execFileSync('git', ['cat-file', '-t', VERSION], { cwd: ROOT, encoding: 'utf8' }).trim();
    check('annotated tag v0.3.1-apo', type === 'tag', `类型=${type}`);
  }
} catch {
  check('annotated tag v0.3.1-apo', false, 'git 查询失败');
}

// ---- 3. AGPL 污染检查可运行 ----
try {
  const out = execFileSync('node', ['scripts/check-license-contamination.mjs'], { cwd: ROOT, encoding: 'utf8' });
  check('污染检查可运行且 PASS', /PASS/.test(out), `exit=0`);
} catch {
  check('污染检查可运行且 PASS', false, '脚本执行失败或命中特征串');
}

// ---- 4. V3 回归证据 ----
for (const f of [
  'test/v3.test.mjs',
  'test/smoke.mjs',
  'test/triage.test.mjs',
  'test/prompt.test.mjs',
  'test/controller.test.mjs',
  'scripts/v3-real-check.mjs',
  'docs/v3-test-migration.md',
]) {
  check(`V3 回归证据存在: ${f}`, existsSync(rel(f)));
}
const realLogDir = rel('logs/v3');
const realLogs = existsSync(realLogDir) ? readdirSync(realLogDir).filter((f) => f.endsWith('.json')) : [];
check('V3 真实模型记录存在', realLogs.length > 0, `${realLogs.length} 份`);

// ---- 5. V3 单架构不变式 ----
for (const f of [
  'src/core/v3.ts',
  'src/core/triage.ts',
  'src/core/types.ts',
  'src/index.ts',
]) {
  check(`V3 契约存在: ${f}`, existsSync(rel(f)));
}
// 旧链路文件必须已删除(只保留一套流程)
const legacyMustBeGone = [
  'src/core/analyze.ts',
  'src/core/classify.ts',
  'src/core/compiler.ts',
  'src/core/discovery.ts',
  'src/core/validate.ts',
  'src/core/validation-flow.ts',
  'src/core/ledger-reconcile.ts',
  'src/core/provenance-recovery.ts',
  'src/core/provenance.ts',
  'src/core/patch-scope.ts',
  'src/core/semantic-ambiguity.ts',
  'src/core/router.ts',
  'src/core/responsibilities.ts',
  'src/core/targets.ts',
  'src/core/registry.ts',
  'src/core/requirements.ts',
  'src/core/disposition-render.ts',
  'src/core/context.ts',
  'src/core/strategies',
];
for (const f of legacyMustBeGone) check(`旧链路已删除: ${f}`, !existsSync(rel(f)));

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
console.log(`[apo] check-dod  v0.3.1-apo  —  ${passes.length} PASS / ${fails.length} FAIL`);
for (const p of passes) console.log(`  ✓ ${p}`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  console.log('[apo] 结果: FAIL —— DoD 机器子集未全绿，禁止宣布发布就绪。');
  process.exit(1);
}
console.log('[apo] 结果: PASS —— DoD 机器子集全绿；DoD 终检（HUMAN）待用户声明 PASS。');
process.exit(0);