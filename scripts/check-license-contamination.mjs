#!/usr/bin/env node
/**
 * check-license-contamination —— AGPL 污染检查（P09-T02 发布必备门禁）。
 *
 * 目的：证明本仓库没有从 AGPL 项目（linshenkx/prompt-optimizer、
 * zhangjiazhi/dsh-prompt-optimizer）复制任何源码 / 模板文本 / 测试。
 * 方法：扫描代码区，查找「只有逐字复制才会出现」的特征串指纹
 * （独特标识符、模板 id、模板 include 语法占位符、文件头句式）。
 *
 * 设计说明：
 * - 指纹取自两仓库实测确认的标识符 / 模板 id / 句法片段，全部属于
 *   「实现标识」而非通用词；通用短语（如「你是优秀的 Prompt 工程师」）
 *   不列入，避免误报。
 * - 默认扫描范围 = src/ + test/ + scripts/ + 根目录文本文件（代码区）。
 *   文档区（docs/、tasks/、README*、NOTICE.md、CHANGELOG.md）
 *   允许提及仓库名与设计来源（引用思想 / 署名），不属于污染。
 * - --all 时额外扫描 docs/ + tasks/（仍跳过构建产物/二进制）。
 * - 退出码：0 = 未发现污染（PASS）；1 = 发现特征串（FAIL）。
 *
 * 用法：
 *   node scripts/check-license-contamination.mjs [--all]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 指纹表：{ source, pattern, note }。pattern 为正则（带 i 可选，见 flags）。 */
const FINGERPRINTS = [
  // ---- zhangjiazhi/dsh-prompt-optimizer（AGPL）lib/ 实测标识符 ----
  { source: 'zhangjiazhi', pattern: /TASK_LIKE_TEMPLATE_IDS/, note: 'lib/validate.js 特有常量名' },
  { source: 'zhangjiazhi', pattern: /USER_MARKER\s*=\s*'<!-- USER -->'/, note: 'lib/templates.js 模板头切分标记' },
  { source: 'zhangjiazhi', pattern: /INCLUDE_PATTERN\s*=/, note: 'lib/templates.js include 正则常量' },
  { source: 'zhangjiazhi', pattern: /TEMPLATE_ID_PATTERN\s*=/, note: 'lib/templates.js 模板 id 正则常量' },
  { source: 'zhangjiazhi', pattern: /\{\{include:[a-z0-9-]+\}\}/, note: '模板 include 展开语法（zhangjiazhi templates/_shared 特色）' },
  { source: 'zhangjiazhi', pattern: /\{\{originalPrompt\}\}|\{\{json:originalPrompt\}\}/, note: 'lib/templates.js 变量约定占位符' },
  // ---- 模板 id（zhangjiazhi templates/ 与 linshenkx default-templates 独有组合）----
  { source: 'zhangjiazhi+linshenkx', pattern: /secure-reverse-optimize/, note: 'zhangjiazhi templates/ 子集 id' },
  { source: 'zhangjiazhi+linshenkx', pattern: /context-message-optimize/, note: 'zhangjiazhi templates/ 子集 id' },
  { source: 'zhangjiazhi+linshenkx', pattern: /user-task-planning/, note: 'zhangjiazhi templates/ 子集 id' },
  { source: 'zhangjiazhi+linshenkx', pattern: /context-output-format-optimize/, note: 'zhangjiazhi templates/ 子集 id' },
  // ---- linshenkx/prompt-optimizer（AGPL）default-templates 独有 id / 文案 ----
  { source: 'linshenkx', pattern: /soul-openclaw-compose/, note: 'linshenkx packages/core default-templates 独有 id' },
  { source: 'linshenkx', pattern: /soul-hermes-compose/, note: 'linshenkx packages/core default-templates 独有 id' },
  { source: 'linshenkx', pattern: /OpenClaw SOUL\.md 生成专家/, note: 'linshenkx soul-openclaw-compose 文案起始句' },
  // ---- zhangjiazhi lib/index.js 移植头句式（逐字复制必有）----
  { source: 'zhangjiazhi', pattern: /移植自 linshenkx\/prompt-optimizer/, note: 'lib/index.js 头部移植声明' },
  // ---- linshenkx packages/core 独特注释/命名（variable-value-generation 等目录）----
  { source: 'linshenkx', pattern: /variable-value-generation/, note: 'linshenkx packages/core 目录名（唯一路径）' },
];

/** 扫描范围。默认代码区；--all 扩展到 docs/ + tasks/。 */
const SCAN_DIRS = ['src', 'test', 'scripts'];
const EXTRA_DIRS = ['docs', 'tasks'];
const ROOT_FILES = ['cordis.patch.yml', 'package.json', 'package-lock.json', 'tsconfig.json'];

const SKIP_DIRS = new Set([
  'node_modules', 'lib', '.git', '__pycache__', 'dist', 'coverage',
  'screenshots', 'promotion', 'runner',
]);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pptx', '.pyc', '.pdf']);

function isTextFile(p) {
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
  if (BINARY_EXT.has(ext)) return false;
  try {
    const head = readFileSync(p, 'utf8').slice(0, 8192);
    // 简单判定：不含 NUL 即视为文本。
    return !head.includes('\0');
  } catch {
    return false;
  }
}

/** 收集待扫描文件路径（相对 ROOT）。检测器自身天然含指纹表，豁免本文件。 */
function collectFiles(all) {
  const out = [];
  const dirs = all ? [...SCAN_DIRS, ...EXTRA_DIRS] : SCAN_DIRS;
  const walk = (dir, base) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, base);
      else if (e.isFile()) out.push(relative(base, full));
    }
  };
  for (const d of dirs) {
    const abs = join(ROOT, d);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) walk(abs, ROOT);
  }
  for (const f of ROOT_FILES) {
    if (statSync(join(ROOT, f), { throwIfNoEntry: false })?.isFile()) out.push(f);
  }
  const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
  return out.filter((p) => p.replace(/\\/g, '/') !== SELF);
}

function main() {
  const all = process.argv.includes('--all');
  const files = collectFiles(all);
  const hits = [];

  for (const rel of files) {
    const abs = join(ROOT, rel);
    if (!isTextFile(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    for (const fp of FINGERPRINTS) {
      const m = text.match(fp.pattern);
      if (m) {
        // 定位行号
        const lineNo = text.slice(0, m.index).split('\n').length;
        hits.push(`${rel}:${lineNo}  ← 【${fp.source}】${fp.note}  (命中: ${m[0].slice(0, 60)})`);
      }
    }
  }

  console.log(`[apo] check-license-contamination  v0.3.2-apo  扫描文件数: ${files.length}  指纹数: ${FINGERPRINTS.length}`);
  console.log(`[apo] 扫描范围: ${all ? 'src+test+scripts+docs+tasks+根文件' : 'src+test+scripts+根文件（代码区）'}`);
  if (hits.length === 0) {
    console.log('[apo] 结果: PASS —— 未发现任何 AGPL 仓库（linshenkx / zhangjiazhi）特征串。');
    process.exit(0);
  }
  console.log(`[apo] 结果: FAIL —— 发现 ${hits.length} 处疑似复制痕迹：`);
  for (const h of hits) console.log(`  ✗ ${h}`);
  console.log('[apo] 停止条件：AGPL 污染为 S-10 级问题，禁止发布；请人工核查后清除。');
  process.exit(1);
}

main();