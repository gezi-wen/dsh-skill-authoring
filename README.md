# dsh-skill-authoring

一个 DSH 插件，内容只有一份技能：安装时把包内的 `skills/` 注册为一个技能根，于是这份技能随插件进入 agent 的技能目录。

```sh
dsh plugin --profile web add dsh-skill-authoring
```

## 技能覆盖什么

- **frontmatter 规范**：必填 / 可选字段、布尔字段的合法写法，以及「一个字符写错就让技能静默消失」的机制
- **技能根与优先级**：rank 100–600 的扫描顺序、同名技能怎么靠项目级根覆盖用户级根、变更检测管到哪一层
- **description 写触发面**：为什么只有它进模型视野、触发线索该怎么堆、边界与兜底怎么写
- **篇幅与拆分**：300–500 行的目标区间、什么时候该拆 `references/`、什么情况不该为数字硬拆
- **静态校验**：`scripts/check-skill.js` 一次查 frontmatter / 必填字段 / 文件引用 / 站内锚点 / `§N` 交叉引用 / 篇幅，可传技能目录或技能根目录，支持 `--json`
- **行为验证**：带技能与不带技能做同一件事的 A/B 对照，对比产物而不是对比自我报告，以及派子 agent 时该写死的纪律

## 布局

```
package.json        # dsh.bundle.patch → cordis.patch.yml
cordis.patch.yml    # 插入一行 @deepseek-ai/dsh-skill-filesystem，customSkillDirs 指向 skills/
skills/
  dsh-skill-authoring/
    SKILL.md
    scripts/
      check-skill.js
```

`cordis.patch.yml` 用的机制和 DSH 自带 agent preset 装载自己的技能是同一套：`!!js` 里的 `baseUrl` 解析到本包，所以路径跟着安装位置走。

`scripts/check-skill.js` 是零依赖的 Node 脚本（`scripts/package.json` 里只写了一行 `{"type": "commonjs"}`，用来抵消本包 `"type": "module"` 对 `.js` 的作用域，让脚本在包内仍按 CommonJS 跑）。它只读文件、不修改任何东西，可以脱离 DSH 直接跑：

```sh
node skills/dsh-skill-authoring/scripts/check-skill.js <技能目录>
```

## License

MIT
