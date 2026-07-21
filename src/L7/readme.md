# 第 7 课：知识库的 Loader 和 Splitter——从各种来源加载文档并分割成小块

> 背景：前端工程师转 agent 开发。L6 手写 7 段短文档直接向量化，这课解决 RAG 的「**数据从哪来 + 怎么切**」——真实文档是文件（网页/PDF/Word），要先加载、再切块，才能向量化。是 RAG 的「前置工程」。

---

## 1. 核心认知

### 1.1 这课在 RAG 链路里的位置

```
L6: 手写短文档 → 向量化 → 检索 → 生成        （检索+生成）
L7: 文件 → Loader → Splitter → 向量化 → ...   （数据准备，L6 的前置）
```

L6 是「检索+生成」，L7 是「**数据准备**」。真实文档不是手写字符串，是文件；而且很长，不能整篇向量化，要先切块。

### 1.2 两个核心角色

- **Loader（加载器）**：把各种来源（网页/PDF/Word/txt）读进来，统一变成 `Document`（pageContent + metadata）。**适配器**——不管源是啥，读出来都是统一结构，下游不用关心源。
- **Splitter（分割器）**：把长文档切成小块（chunk），每块单独向量化。让「检索粒度」匹配「问答粒度」。

---

## 2. 逐段拆解

### loader-and-splitter.mjs（纯演示 loader + splitter）

**① CheerioWebBaseLoader 抓网页（第 2-13 行）**

```js
import "cheerio";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";

const cheerioLoader = new CheerioWebBaseLoader(
  "https://juejin.cn/post/7233327509919547452",
  { selector: ".main-area p" },   // 只抓 .main-area 下的 p 标签
);
const documents = await cheerioLoader.load();
```

- `cheerio`：前端熟悉的 jQuery 风格 HTML 解析库（服务端版）。
- `selector: ".main-area p"`：**只抓正文段落**，过滤掉导航、广告、评论等噪声。这是网页 loader 的关键——网页有大量无关 DOM，不选 selector 会把导航栏也当正文。
- `load()` 返回 `Document[]`，每个含 `pageContent`（正文）+ `metadata`（source/title/loc）。

**② RecursiveCharacterTextSplitter 切块（第 15-21 行）**

```js
const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 400,        // 每块最多 400 字符
  chunkOverlap: 50,     // 相邻块重叠 50 字符
  separators: ["。", "！", "？"],  // 分隔符优先级
});
const splitDocuments = await textSplitter.splitDocuments(documents);
```

三个参数见「关键机制详解」。

### loader-and-splitter2.mjs（完整 RAG：loader + splitter + 检索 + 生成）

在第一个文件基础上，接上 L6 的 RAG 流程：

**① 模型准备（第 8-24 行）** —— 复用 L6 的两套配置（ChatOpenAI + OpenAIEmbeddings），**保留了 `encodingFormat: "float"`**（L6 踩的全零坑，这课记住了）。

**② Loader + Splitter（第 26-44 行）** —— 同第一个文件，`chunkSize: 500`，切成 4 块。

**③ 建库 + 检索 + 生成（第 51-106 行）** —— 和 L6 一样的 RAG 流程，`k: 2` 取 2 段，拼 prompt 让 AI 答。

**④ 相似度打印（第 78-86 行）** —— 本课踩的坑：`1 - score` 是错的（见下「3.4」）。

---

## 3. 关键机制详解

### 3.1 为什么必须切块（不切块的两大问题）

1. **embedding 输入长度限制**：bge-m3 等模型输入上限 512~8192 token，整篇几千字**超了被截断**，后半段丢，向量化不全。
2. **检索粒度太粗 + 噪声**：整篇一个向量，检索时整篇返回。一篇讲 5 个话题的文章，问其中 1 个，AI 拿到整篇（含 4 个无关话题）→ 噪声淹没信号，答不准。

> 切块 = 让「检索粒度」匹配「问答粒度」。问一小点，只捞那一小段。

### 3.2 chunkOverlap：平衡完整性和冗余

**不重叠的问题**：一句话/论点正好被切在边界，前半在 chunk A、后半在 chunk B。检索只捞到 A，**关键信息被腰斩**，AI 答不全。

**重叠的作用**：相邻块共享 50 字符，**边界内容在两个块里都有**，检索到任一块都能拿到完整上下文。

**平衡什么**：重叠大 → 上下文完整但**重复多、浪费 token、库变大**；重叠小 → 省空间但**边界信息易丢**。50 是经验值，平衡「完整性」和「冗余成本」。

### 3.3 递归分割：优先级降级，不是取最优

`separators: ["。","！","？"]` 的「递归」工作方式：

1. 先用「。」切，切完如果某块还超 `chunkSize` → 进入下一层
2. 对超大的块用「！」切，还超 → 用「？」切
3. 还超 → 用更细的分隔符（默认还有换行、空格）

**为什么不用单一分隔符**：只用「。」，万一某段 1000 字一个句号都没有（长排比），那块就超大没法切到 500 以内。**递归 = 优先按语义边界（句号）切，切不动就降级用更细的**，保证每块都不超限，同时尽量沿语义边界。

> 递归不是「取最优解」，是「**优先用最好的分隔符，切不动就降级**」——既保证块不超限，又尽量沿语义边界（句号优先于问号优先于空格）。

### 3.4 `1 - score` 坑（L6 知识点复现）

[第 79 行](../L7/loader-and-splitter2.mjs#L79) 原本 `const similarity = (1 - score).toFixed(4)` —— **错的**。

查源码确认（`@langchain/classic/dist/vectorstores/memory.js`）：

```js
this.similarity = similarity ?? cosine;   // 第126行：默认用 cosine 函数
.sort((a, b) => a.similarity > b.similarity ? -1 : 0)  // 第172行：相似度大的排前面
```

`MemoryVectorStore` 返回的 `score` **就是余弦相似度本身**（越大越像），不该用 `1 - score` 转。`1 - score` 是把「距离」转「相似度」才用的——这里 score 已经是相似度，转了反而把「越像」算成「越不像」。

**已修复**：改成 `score.toFixed(4)`。

**判断标准（重要）**：看 `score` 是「相似度」还是「距离」：

- 相似度（越大越像，如余弦）→ 直接用 `score`
- 距离（越小越像，如欧氏）→ 用 `1 - score` 转

**不同库不同**：Chroma/Faiss 返回距离（要转），MemoryVectorStore 返回相似度（不转）。**没有统一标准**，要看具体库。这是 L6 讲过的点，L7 又写错，说明没内化——这次查源码确认了。

### 3.5 Loader 的统一化 = 解耦（不是效率）

Loader 把网页/PDF/Word 都变成 `Document`，**下游流程（切块、向量化、检索、生成）不用管源是啥**。写一次 RAG 流程，能处理任何来源。

不统一会怎样：每种源写一套处理逻辑（网页 cheerio、PDF pdf-parse、Word mammoth），每套都自己处理切块向量化，**代码重复、难维护**。

> Loader = **适配器模式**，把各种源适配成统一接口，下游只认 `Document`。价值是「解耦」，不是「效率」。

### 3.6 metadata 的溯源价值

跑出来的 metadata 含 `source`（URL）、`title`、`loc: { lines: { from, to } }`：

- **`source`/`title`**：回答里能标注「这段来自掘金某文章」，用户能点回去核实。
- **`loc` 行号**：**行号溯源**——AI 答错或用户想看原文上下文，能定位到原文第几行。调试时也极有用：检索结果不对，能跳到原文对应位置排查。

> metadata 让 RAG 从「黑盒给答案」变成「**可溯源的答案**」——RAG 相比纯 LLM 的关键优势，生产级 RAG 必备。

---

## 4. 概念辨析

### 4.1 L6 vs L7 在 RAG 链路的位置

|          | L6               | L7                                   |
| -------- | ---------------- | ------------------------------------ |
| 文档来源 | 手写字符串       | 文件（网页/PDF/Word）                |
| 是否切块 | 不切（本来就短） | 切（RecursiveCharacterTextSplitter） |
| 阶段     | 检索+生成        | 数据准备（加载+切块）                |
| 关系     | L7 是 L6 的前置  | L7 接上 L6 才完整                    |

### 4.2 RecursiveCharacterTextSplitter vs CharacterTextSplitter

|            | RecursiveCharacterTextSplitter | CharacterTextSplitter      |
| ---------- | ------------------------------ | -------------------------- |
| 分隔符     | 多个，按优先级递归降级         | 单一                       |
| 超大块处理 | 降级用更细分隔符继续切         | 切不动就超限               |
| 语义边界   | 尽量沿语义边界（句号优先）     | 只认一个分隔符             |
| 适合       | 通用文本（默认选这个）         | 结构固定、分隔符明确的文本 |

### 4.3 score：相似度 vs 距离（见 3.4）

|                 | 相似度                      | 距离                 |
| --------------- | --------------------------- | -------------------- |
| 越大越像        | ✅                           | ❌（越小越像）        |
| 要不要`1-score` | ❌ 不用                      | ✅ 要转               |
| 例子            | MemoryVectorStore（cosine） | Chroma/Faiss（欧氏） |

---

## 5. 踩坑提醒

1. **`1 - score` 要看库** —— MemoryVectorStore 返回相似度不用转；Chroma/Faiss 返回距离才转。没有统一标准，查源码或文档确认。
2. **网页 loader 要选 selector** —— 不选会把导航/广告/评论也当正文，噪声污染。`.main-area p` 只抓正文段落。
3. **`encodingFormat: "float"` 别忘** —— L6 的全零坑，海康接口对 base64 解析有问题，这课记住了要保留。
4. **chunkSize 别太大** —— 超 embedding 输入上限会被截断，向量化不全。500 是经验值。
5. **chunkOverlap 平衡完整性和冗余** —— 太小边界信息丢，太大重复浪费。50 经验值。
6. **递归分割的 separators 顺序就是优先级** —— `["。","！","？"]` 表示句号优先、问号最后。中文场景要放中文标点，别用英文默认。
7. **metadata 要利用** —— source/title/loc 能溯源、能过滤、能调试，别只当摆设。

---

## 6. 和前面课程的关系

```
L6  RAG 检索+生成（手写短文档）    检索+生成这条线
L7  Loader + Splitter（真实文档）  数据准备，L6 前置
```

L7 补上了 L6 缺的「数据准备」环节。完整 RAG = **L7（加载+切块）+ L6（向量化+检索+生成）**。两课合起来才是从「真实文档」到「AI 回答」的完整链路。

---

## 7. 下一步

- **加更多 loader**：PDFLoader、DocxLoader、DirectoryLoader（读整个目录），体会适配器模式
- **调 chunkSize/Overlap 对比**：试 200/800、0/100，看检索质量变化，建立参数直觉
- **加 metadata 过滤**：实现「只在某来源搜」「只搜某章节」
- **换持久化向量库**：MemoryVectorStore 换 Chroma，数据落盘 + 返回距离（注意 `1-score` 要改回来）
- **加 rerank**：粗检索多取，再精排，提精度
