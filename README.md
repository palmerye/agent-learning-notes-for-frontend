# 神光的 Agent 课程学习辅助+陪练

> 不是又一个"课程笔记仓库",而是一个**带方法论引擎的学习辅助**:把学习科学 + superpowers 的 skill 工程化结合,让每节课的「敲码 → 巩固 → 笔记」变成一套可复用、可验证的固定流程。

如果你也在跟神光的 Agent 课程,这个 repo 想解决一个问题:**自己学容易"敲完就忘"**。代码跑通了,但为什么这么写、和别的概念什么关系,讲不清。这个辅助内置了一个 Claude Code skill,每节课自动陪你走完一套有方法论支撑的巩固流程,最后产出结构化笔记。

欢迎fork和star ✨～

---

## 学习笔记索引

- [L1 AI Agent 开发要学什么？](src/L1/readme.md) — 跑通第一个 LLM 调用
- [L2 从 Tool 开始：让大模型自动调工具读文件](src/L2/readme.md) — 最小 agent(工具调用 + 循环)
- [L3 实现 mini cursor：大模型自动调用 tool 执行命令](src/L3/readme.md) — spawn + 4 工具 + agent 循环(多文件)
- [L4 MCP：让工具跨进程、可复用、可组合](src/L4/readme.md) — MCP client/server + 资源 vs 工具 + JSON-RPC 跨进程
- [L5 复用别人的 MCP Server：高德 + 浏览器 + 文件系统](src/L5/readme.md) — 多 server 协作 + stdio/HTTP + 异常自动截图报告闭环
- [L6 把文档向量化：基于向量实现真正的语义搜索](src/L6/readme.md) — RAG 全链路 + 向量本质 + 余弦相似度 + embedding 全零坑

---

## 它怎么辅助你(每课 6 步)

对 Claude Code 说 `开始学第 4 课：xxx`,skill 自动启动:

| 步骤             | 做什么                                                   | 为什么有效                |
| ---------------- | -------------------------------------------------------- | ------------------------- |
| 1 建目录         | `src/Ln/` 下建本课目录                                   | 一课一目录,代码笔记同处   |
| 2 陪练敲码       | 你对照课程敲,skill**主动**提示重点/难点                  | 不等你问,把隐藏概念挖出来 |
| 3 提问查漏       | 敲完抛 3-5 个**设计意图题**(如"为什么用 let 不用 const") | 逼主动回忆,比看笔记记得牢 |
| 4 互动补缺       | 答错先**追问**引导,不直接给答案(最多 2 轮)               | 暴露盲区,定位到具体行     |
| 5 生成 readme.md | 按 7 部分骨架写笔记到`src/Ln/readme.md`                  | 结构统一,不凭感觉         |
| 6 更新索引       | 本 Readme 追加一条笔记链接                               | 方便回查                  |

**关键设计**:提问只问"为什么这么设计",不问"X 是什么"(事实题查文档就行,不值得占提问额度);不评分不打勾叉,只说"对/这里还差一点"——这是巩固,不是考试。

---

## 支撑的方法论

这套流程不是拍脑袋想的,每一步都落在学习科学上:

**学习科学层面**

- **最近发展区(ZPD)** — 用你已有的强项(前端/Node)当锚点学新概念,不从陌生地基切入
- **做中学(Project-based)** — 每课都落到能跑的代码,看懂 ≠ 会写
- **主动回忆(Active Recall)** — 第 3 步提问逼你想,比反复读笔记有效
- **费曼学习法** — 第 5 步写笔记 = 用自己的话讲一遍,讲不清就是没懂
- **刻意练习** — 提问专攻最薄弱的"设计意图理解",不是反复做会的

**superpowers 工程化层面**

- 这个 skill 本身是用 [superpowers](https://github.com/obra/superpowers) 的全流程产出的:`brainstorming`(设计)→ `writing-plans`(计划)→ `subagent-driven-development`(执行)
- skill 不是随便写的,是用 **TDD for skills** 开发的(见下节)

**前端类比策略**

- 学习者画像固定是前端工程师,所以用前端类比挂载新知识——但**只在和前端思想差异大的地方**用(如"模型只会输出文字,真正干活的是你的程序",这与前端"用户点按钮触发动作"的直觉相反);差异不大的(如"用 let 因为要改")不强行类比,避免生硬。

---

## 举个🌰

每次和ai聊的时候，它会针对性的出题，然后循序渐进的帮助你回答，建立自己的知识网络。如果太难，它会帮你拆解，然后降低难度，浅入深出。
<img width="1060" height="888" alt="image" src="https://github.com/user-attachments/assets/971f887b-d65b-412a-ba0f-4cb4324fb1ac" />
<img width="1062" height="976" alt="image" src="https://github.com/user-attachments/assets/f8c72964-cb48-4968-ba89-a1e7f7c68467" />




## 这个 skill 怎么来的(TDD for skills,透明可查)

按 superpowers 的 `writing-skills` 铁律:**没有先看到失败,就不知道 skill 该教什么**。所以开发流程是:

```
RED    跑无 skill 基线 → 记录 agent 自然会犯的错
GREEN  基于真实失败写 skill → 逐条加约束堵住
REFACTOR  带 skill 重跑 → 验证失败被堵住
```

**基线发现了 5 类系统性失败**(在 L1/L3 两个真实样本上都复现):

| 失败         | 基线(无 skill)     | skill 堵法      |
| ------------ | ------------------ | --------------- |
| 提问超量     | 抛 6-10 个         | 硬上限 5 个     |
| 混入事实题   | "X 还有哪些字段"   | 只问设计意图题  |
| 笔记结构自创 | 自创 8-11 章节编号 | 固定 7 部分骨架 |
| 漏更新索引   | 忘了加 Readme 链接 | 第 6 步必须项   |
| 前端类比滥用 | 每处都生硬类比     | 只在差异大处    |

**验证结果**:带 skill 重跑 L1/L3,5 类失败全部堵住。跑过对照实验。

---

## 怎么用(3 步上手)

```bash
git clone <这个仓库>
cd <仓库目录>
claude   # 用 Claude Code 打开
```

然后直接对它说:

```
开始学第 4 课：xxx
```

skill 会自动走完上面 6 步。**不需要你额外声明"用 skill"**,识别到"开始学第 N 课"就启动。

> 前置:本仓库的代码用 `@langchain/openai` + dotenv,需在根目录配 `.env`(`API_KEY` / `BASE_URL` / `MODEL_NAME`)。`.env` 已在 `.gitignore`,不会泄露。

---

## 目录结构

```
src/Ln/                          每课:实操代码(可多文件)+ readme.md
.claude/skills/course-study-coach/   内置 skill(TDD 产出)
docs/superpowers/
  ├ specs/                       设计 spec
  ├ plans/                       实现计划
  └ baseline-records/            基线测试归档(skill 怎么推导来的)
```

---

## 给课程同学的话

如果你也在跟这门课,欢迎 fork 这个 repo 或只拿走 [`.claude/skills/course-study-coach/`](.claude/skills/course-study-coach/) 这个 skill 放进你自己的学习仓库。skill 本身和课程内容解耦——只要你的学习方式是"每课建目录 + 敲码 + 写 readme.md",它就能用。

## 烧钱数💰💰

| 项 | 值 |
|---|---|
| 花费 | $3.00 |
| 输入 token | 453.2k(含 1.1m cache 命中) |
| 输出 token | 7.7k |

会不会有热心同学众筹一下 = =

<img width="250" height="250" alt="image" src="https://github.com/user-attachments/assets/804cc35f-c473-4970-a9a0-3675fe09372e" />
