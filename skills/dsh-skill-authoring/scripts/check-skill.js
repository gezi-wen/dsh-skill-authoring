#!/usr/bin/env node
/**
 * check-skill.js —— DSH 技能的静态校验器
 *
 * 为什么需要它：DSH 对无效技能的处理是「随警告跳过」，而**模型侧拿不到逐技能诊断，
 * 也无法区分「缺失」与「无效」**。所以技能写坏了只会表现为「不见了」，没有任何错误
 * 指向原因。本脚本把这件事变成一条可执行的命令。
 *
 * 用法：
 *   node check-skill.js <技能目录>
 *   node check-skill.js <技能根目录>        # 逐个校验其下带 SKILL.md 的子目录
 *   node check-skill.js                    # 不给参数：DSH_SKILL_DIR 环境变量 → 当前目录
 *   node check-skill.js <目录> --json
 *
 * 路径不写死：位置参数给到哪就查哪，不给就读 DSH_SKILL_DIR，再退到当前工作目录。
 * 脚本只读，不修改任何文件。
 *
 * 退出码：0 = 全过；1 = 有问题；2 = 用法错误。
 *
 * 检查项：
 *   1. frontmatter 存在且能被 YAML 解析（`: ` 这类未加引号的冒号是头号杀手）
 *   2. 必填字段 name / description 在位；name 与目录名一致
 *   3. 布尔字段（disable-model-invocation / user-invocable）拼写合法
 *   4. description 不含 `: `；长度合理
 *   5. 正文引用的 references/ scripts/ assets/ 文件真实存在
 *   6. 站内锚点 `](#xxx)` 指向真实标题
 *   7. `§N` 交叉引用指向真实章节
 *   8. 行数落在建议区间
 */

const fs = require('fs');
const path = require('path');

const REQUIRED = ['name', 'description'];
const OPTIONAL = ['whenToUse', 'metadata', 'disable-model-invocation', 'user-invocable'];
const BOOL_FIELDS = ['disable-model-invocation', 'user-invocable'];
const LINECOUNT_MIN = 300;
const LINECOUNT_MAX = 500;

const USAGE = `用法: node check-skill.js [<技能目录 | 技能根目录>] [--json]

  位置参数省略时，按 DSH_SKILL_DIR 环境变量 → 当前工作目录 依次取值。
  目标里有 SKILL.md 就按单个技能校验；没有就把它当技能根目录，
  逐个校验其下带 SKILL.md 的子目录（跳过隐藏目录与 node_modules）。`;

/** 找一个可用的 YAML 解析器；找不到就返回 null（走内置最小解析器） */
function loadYaml() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const candidates = [
    path.join(home, 'profiles', 'node_modules', 'yaml'),
    path.join(home, 'profiles', 'web', 'node_modules', 'yaml'),
  ];
  for (const c of candidates) {
    try { return { yaml: require(c), from: c }; } catch (e) { /* 继续找 */ }
  }
  return null;
}

/**
 * 内置最小 frontmatter 解析器 —— 只在拿不到 yaml 包时兜底。
 * 它不追求完整 YAML，只保证两件事：能读出顶层 key，以及**能识破本次要防的那类错误**
 * （未加引号的值里出现 `: `，会开启嵌套映射）。
 */
function minimalParse(block) {
  const out = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) continue; // 缩进行，属于上一个键
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) return { error: `第 ${i + 1} 行不是合法的顶层键值：${JSON.stringify(line.slice(0, 60))}` };
    const [, key, rawVal] = m;
    const val = rawVal.trim();
    const quoted = (val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
                   (val.startsWith("'") && val.endsWith("'") && val.length > 1);
    if (!quoted && /: /.test(val)) {
      return { error: `第 ${i + 1} 行 ${key} 的值里有未加引号的 ": "（半角冒号+空格）—— 这会让 YAML 解析失败、整个技能被静默丢弃。改用全角「：」，或给整个值加引号，或改写句式。` };
    }
    out[key] = quoted ? val.slice(1, -1) : val;
  }
  return { value: out };
}

/**
 * GitHub 风格锚点：小写 → 去掉非字母数字空格连字符下划线 → 空格转连字符。
 * 注意是**每个空格各换一个连字符**，不合并连续空格 ——
 * `修链接（junction / symlink）` 去掉斜杠后剩两个空格，锚点就是 `修链接junction--symlink`。
 */
function slug(heading) {
  return heading
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/**
 * 去掉围栏代码块与行内代码，再做引用扫描。
 * 理由：技能正文里常放**模板示例**（骨架、片段），那些 `](#xxx)`、`references/x.md`
 * 是举例不是真引用；不剔除就会天天误报，最后没人信这个校验器。
 */
function stripCode(text) {
  return text
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/** 从标题里取出章节代号：开头的数字编号（2.5）或中文序号（二） */
function sectionToken(heading) {
  const t = heading.replace(/^#+\s*/, '');
  const m = t.match(/^([0-9]+(?:\.[0-9]+)*|[一二三四五六七八九十]+)/);
  return m ? m[1] : null;
}

/**
 * 把一个技能根目录展开成技能目录列表。
 * 目标目录顶层有 SKILL.md → 它自己就是一个技能；否则找它下面第一层带 SKILL.md 的子目录。
 */
function findSkillDirs(target) {
  if (fs.existsSync(path.join(target, 'SKILL.md'))) return [target];
  let entries;
  try { entries = fs.readdirSync(target); } catch (e) { return []; }
  const dirs = [];
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const p = path.join(target, name);
    try {
      if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'SKILL.md'))) dirs.push(p);
    } catch (e) { /* 读不到的条目直接跳过 */ }
  }
  return dirs.sort();
}

/** 校验单个技能目录，返回报告对象（不打印、不退出） */
function checkSkill(dir) {
  const problems = [];
  const notes = [];
  const fail = (msg) => problems.push(msg);
  const note = (msg) => notes.push(msg);

  const skillDir = path.resolve(dir);
  const skillFile = path.join(skillDir, 'SKILL.md');
  const raw = fs.readFileSync(skillFile, 'utf8');
  const dirName = path.basename(skillDir);

  // ── 1. frontmatter ─────────────────────────────────────────────
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let meta = null;
  let parserUsed = 'none';
  if (!fmMatch) {
    fail('没有 frontmatter 块（文件必须以 --- 开头，紧跟 YAML，再以 --- 结束）');
  } else {
    const loader = loadYaml();
    if (loader) {
      parserUsed = 'yaml 包 (' + loader.from + ')';
      try {
        meta = loader.yaml.parse(fmMatch[1]);
      } catch (e) {
        fail(`frontmatter YAML 解析失败（${e.message.split('\n')[0]}）—— 技能会被静默丢弃`);
      }
    } else {
      parserUsed = '内置最小解析器（未找到 yaml 包）';
      const r = minimalParse(fmMatch[1]);
      if (r.error) fail('frontmatter 解析失败：' + r.error);
      else meta = r.value;
    }
  }

  const body = raw.slice(fmMatch ? fmMatch[0].length : 0);
  const lines = raw.split('\n');

  // 引用类检查一律在「剔除代码块」后的文本上做，避免把模板示例当真引用
  const scan = stripCode(body);

  // ── 2~4. 字段检查 ──────────────────────────────────────────────
  if (meta) {
    for (const f of REQUIRED) {
      if (meta[f] === undefined || String(meta[f]).trim() === '') fail(`缺必填字段 ${f}`);
    }
    if (meta.name !== undefined && meta.name !== dirName) {
      fail(`name (${meta.name}) 与目录名 (${dirName}) 不一致 —— 改名等于换了个技能，旧名调用会失效`);
    }
    if (meta.name !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(meta.name))) {
      note(`name 不是 kebab-case：${meta.name}`);
    }
    for (const f of BOOL_FIELDS) {
      if (meta[f] === undefined) continue;
      const v = String(meta[f]).toLowerCase();
      if (!['true', 'false', 'yes', 'no', 'on', 'off', '1', '0'].includes(v)) {
        fail(`${f} 的值 ${JSON.stringify(meta[f])} 不是合法布尔写法 —— 非法值会让整个技能被丢弃`);
      }
    }
    for (const k of Object.keys(meta)) {
      if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) note(`未知的 frontmatter 字段 ${k}（DSH 只认 ${[...REQUIRED, ...OPTIONAL].join(' / ')}）`);
    }
    const d = String(meta.description || '');
    if (/: /.test(d)) fail('description 里有未加引号的 ": " —— 会破坏 YAML');
    if (d.length > 0 && d.length < 80) note(`description 偏短（${d.length} 字符），可能不足以让模型分辨何时该用`);
    if (!/use when|use this|use it|when |trigger|适用|触发|用本技能/i.test(d)) note('description 里看不出明确的触发条件（建议写清"什么时候用"）');
  }

  // ── 5. 文件引用 ────────────────────────────────────────────────
  const fileRefs = [...new Set(
    (scan.match(/\]\((?!https?:|#)([^)]+)\)/g) || [])
      .map((x) => x.slice(2, -1).split('#')[0])
      .filter((x) => /^(references|scripts|assets)\//.test(x))
  )];
  for (const r of fileRefs) {
    if (!fs.existsSync(path.join(skillDir, r))) fail(`引用的文件不存在：${r}`);
  }

  // ── 6. 站内锚点 ────────────────────────────────────────────────
  const headings = (scan.match(/^#{1,6} .+$/gm) || []).map(slug);
  const headingSet = new Set(headings);
  const anchors = [...new Set((scan.match(/\]\(#[^)]+\)/g) || []).map((x) => x.slice(3, -1)))];
  for (const a of anchors) {
    if (!headingSet.has(a)) fail(`锚点 #${a} 找不到对应标题`);
  }

  // ── 7. §N 交叉引用 ─────────────────────────────────────────────
  const secRefs = [...new Set((scan.match(/§\s?(?:[0-9]+(?:\.[0-9]+)*|[一二三四五六七八九十]+)/g) || []))]
    .map((x) => x.replace(/§\s?/, ''));
  const headTokens = (scan.match(/^#{2,6} .+$/gm) || [])
    .map(sectionToken)
    .filter(Boolean);
  for (const s of secRefs) {
    if (!headTokens.includes(s)) fail(`交叉引用 §${s} 找不到对应章节标题`);
  }

  // ── 8. 篇幅 ────────────────────────────────────────────────────
  const n = lines.length;
  if (n < LINECOUNT_MIN) note(`SKILL.md ${n} 行，低于建议区间 ${LINECOUNT_MIN}-${LINECOUNT_MAX}（先想清楚有没有漏边界情况；内容确实完整就别为凑数字注水）`);
  if (n > LINECOUNT_MAX) fail(`SKILL.md ${n} 行，超过建议上限 ${LINECOUNT_MAX} —— 该拆 references/ 了`);

  // ── 报告 ───────────────────────────────────────────────────────
  return {
    skill: dirName,
    file: skillFile,
    lines: n,
    parser: parserUsed,
    frontmatter: meta,
    anchors: anchors.length,
    fileRefs: fileRefs.length,
    secRefs: secRefs.length,
    problems,
    notes,
    ok: problems.length === 0,
  };
}

/** 打印单个技能的报告（单技能与多技能模式共用，保持人读格式一致） */
function printReport(r) {
  console.log(`技能 ${r.skill}  (${r.lines} 行，解析器：${r.parser})`);
  console.log(`  字段 ${r.frontmatter ? Object.keys(r.frontmatter).length : 0} · 锚点 ${r.anchors} · 文件引用 ${r.fileRefs} · §引用 ${r.secRefs}`);
  if (r.problems.length) {
    console.log('\n  ❌ 问题：');
    for (const p of r.problems) console.log('     · ' + p);
  }
  if (r.notes.length) {
    console.log('\n  ⚠️  提醒：');
    for (const m of r.notes) console.log('     · ' + m);
  }
  console.log(r.problems.length ? '\n结论：有问题' : '\n结论：通过 ✅');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const json = args.includes('--json');
  const dir = args.find((a) => !a.startsWith('--'));
  const target = path.resolve(dir || process.env.DSH_SKILL_DIR || process.cwd());
  if (!fs.existsSync(target)) {
    console.error(`找不到 ${target}`);
    console.error(USAGE);
    process.exit(2);
  }

  const dirs = findSkillDirs(target);
  if (dirs.length === 0) {
    console.error(`在 ${target} 里没找到技能（顶层没有 SKILL.md，下一层子目录也没有）`);
    console.error(USAGE);
    process.exit(2);
  }

  const reports = dirs.map(checkSkill);
  const failed = reports.filter((r) => !r.ok).length;

  if (json) {
    console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  } else {
    reports.forEach(printReport);
    if (reports.length > 1) {
      console.log(`\n共 ${reports.length} 个技能，其中 ${failed} 个有问题。`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
