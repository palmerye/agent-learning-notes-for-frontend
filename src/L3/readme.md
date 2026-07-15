# 第 3 课：实现 mini cursor — 大模型自动调用 tool 执行命令

> 这课把 L1 的"单次调用"、L2 的"工具+循环"组装成一个能干真活的 agent：模型能读文件、写文件、跑命令、列目录，**自主决定调哪个工具、循环多轮直到完成任务**。这就是一个最小的 "cursor"。
>
> 三个文件：`node_exec.mjs`（spawn 基础）→ `all-tools.mjs`（封装 4 个工具）→ `mini-cursor.mjs`（agent 循环）。

源码：`src/L3/node_exec.mjs` · `src/L3/all-tools.mjs` · `src/L3/mini-cursor.mjs`

---

## 核心认知

### 1. 调不调工具，是模型决定的，不是你决定的

这课和前端直觉**相反**，必须类比，否则会理解错：

- **前端直觉**：你写一个函数，**你**（程序员）决定什么时候调它。
- **这里反过来**：你写一个 tool，但**调不调、调哪个、传什么参数，是模型在运行时决定的**，不是你。你只提供"能力"（工具）和"规则"（SystemMessage）。

类比：你像在给一个**看文档盲选的实习生**写工具箱——你把螺丝刀、锤子放进箱子（tool），写清楚每把工具干嘛（description），然后说"去把桌子修好"（HumanMessage）。实习生自己判断该拿哪把、怎么用，做不完继续，做完汇报。你不是手把手教每一步。

模型靠 `name` + `description` 判断该用哪个工具——所以 description 写不好模型就用错，name 重复模型就分不清。

### 2. agent 循环是"问 → 调工具 → 喂回结果 → 再问"，模型自己决定何时停

L1 是"问一句答一句"就结束。这课有个循环：模型每轮要么调工具（你执行后把结果塞回 messages，再问一次），要么不调工具（任务完成，输出最终回复）。**退出循环 = 模型不再调工具 = 任务做完了。**

---

## 逐段拆解

### `node_exec.mjs` — spawn 基础（让 Node 跑 shell 命令）

这是 L3 的地基，先单独理解 spawn。30 行代码让 Node 跑起 `ls -la`。

**① 导入 + 解析命令（第 1-6 行）**
```js
import { spawn } from "node:child_process";
const command = "ls -la";
const [cmd, ...args] = command.split(" ");   // 拆成 cmd="ls", args=["-la"]
```
`split(" ")` 是个玩具解析器，遇到带空格/引号的参数会断（见踩坑）。

**② spawn 启动 + 三个 option（第 8-12 行）**
```js
const child = spawn(cmd, args, {
  cwd,                // 子进程工作目录
  stdio: "inherit",   // 输出直接打到终端
  shell: true,        // 走 shell 解释（能用管道/通配符，但有注入风险）
});
```
spawn 返回的是 ChildProcess 对象（EventEmitter），不是"命令结果"——结果要靠监听事件拿。

**③ error / close 事件 + 退出（第 14-29 行）**
```js
let errorMsg = "";
child.on("error", (error) => { errorMsg = error.message; });  // spawn 失败（进程没起来）
child.on("close", (code) => {                                  // 一定触发，是终结信号
  if (code === 0) process.exit(0);
  else { if (errorMsg) console.error(...); process.exit(code || 1); }
});
```
`error` = 进程没起来（带原因），`close` = 跑完了（带退出码）。用外层 `let errorMsg` 在两个事件间传话，统一在 close 收尾。

### `all-tools.mjs` — 封装 4 个工具

把能力包成 LangChain 的 `tool()`，让模型能调用。每个 tool = 执行函数 + 元信息（name/description/schema）。

**① read_file（第 8-29 行）** — 读文件，失败要 return 错误字符串（不能只 console.log）。
**② write_file（第 32-56 行）** — 写文件，`path.dirname` + `mkdir recursive` 自动建目录。注意函数参数要解构出 `content`：`({ filePath, content })`，否则 schema 里的 content 拿不到。
**③ execute_command（第 60-109 行）** — 用 spawn 跑命令，包在 `return new Promise` 里（因为 spawn 是事件驱动，要等 close 事件再 resolve）。
**④ list_directory（第 112-134 行）** — `fs.readdir` 列目录。

**关键**：每个工具的 `description` 是给模型看的"使用说明"，写清"什么时候用"。工具失败要 `return` 错误字符串（不是 throw），让模型看到错误能改参数重试。

### `mini-cursor.mjs` — agent 循环（把工具绑到模型上跑）

**① 初始化模型 + 绑定工具（第 16-32 行）**
```js
const model = new ChatOpenAI({ modelName, apiKey, configuration: { baseURL } });
const modelWithTools = model.bindTools(tools);   // 告诉模型"这次可以用这些工具"
```
`bindTools` 不是立刻调用，是把工具元信息转成 OpenAI 协议的 `tools` 参数发给模型。

**② runAgentWithTools 函数（第 35-89 行）— 全文核心**
```js
async function runAgentWithTools(query, maxIterations = 30) {
  const messages = [new SystemMessage(`...`), new HumanMessage(query)];

  for (let i = 0; i < maxIterations; i++) {        // ← 有上限，防死循环
    const response = await modelWithTools.invoke(messages);
    messages.push(response);

    if (!response.tool_calls?.length) {            // 模型不调工具 → 任务完成
      return response.content;
    }

    for (const toolCall of response.tool_calls) {  // 执行所有工具调用
      const foundTool = tools.find((t) => t.name === toolCall.name);
      if (foundTool) {
        const toolResult = await foundTool.invoke(toolCall.args);
        messages.push(new ToolMessage({ content: toolResult, tool_call_id: toolCall.id }));
      }
    }
  }
  return response.content;   // 跑满上限，强制停止
}
```

**③ 任务 + 启动（第 89-117 行）** — 定义 case1（创建 React TodoList），`try { await runAgentWithTools(case1) } catch {...}`。

---

## 关键机制详解

### 机制一：agent 循环为什么需要 maxIterations 上限

LLM 是**概率性**的，不是确定性程序。模型调工具失败后，看到失败信息**不保证**能正确分析原因、改对参数——它可能误判"再试一次也许行"，于是"失败 → 重试 → 还失败 → 再试"无限转。

模型自己没有可靠的"自我停止"机制，所以需要**外部硬上限**（`maxIterations = 30`）兜底：不管模型想不想停，跑满 30 轮强制停。这是用工程手段兜住 LLM 的不可控自主性。

```
正常：调工具→成功→调工具→成功→不调了→输出最终回复 ✅
死循环：调工具→失败→重试→失败→重试→...（模型自己停不下来）→ maxIterations 强制停 ⚠️
```

### 机制二：stdio 模式在 agent 场景的取舍（inherit vs pipe）— 本课核心伏笔

`execute_command` 工具用了 `stdio: "inherit"`，命令输出直接打到终端屏幕。

- **给人看（inherit）**：输出打到屏幕，人能看到，但**程序拿不到内容**。
- **给 agent 看（pipe）**：输出进管道，程序监听 `child.stdout` 的 `data` 事件收集，能拿到内容返回给模型。

**矛盾**：agent 调 `execute_command("ls -la")` 想看目录内容，但 inherit 模式下，工具返回给模型的只是"命令执行成功"这句话，**没有 ls 的输出**。模型不知道目录里有什么，只能乱猜或白调。

**正确做法**：agent 工具要用 `pipe`，自己收集 stdout 返回给模型：
```js
const child = spawn(cmd, args, { cwd, stdio: "pipe", shell: true });
let output = "";
child.stdout.on("data", (data) => { output += data.toString(); });
child.on("close", (code) => {
  resolve(code === 0 ? `输出:\n${output}` : `失败:${output}`);
});
```

```
inherit:  ls输出 ──► 终端屏幕（人看到）     模型拿不到 ❌
pipe:     ls输出 ──► child.stdout ──► 收集成字符串 ──► resolve 回模型 ✅
```

### 机制三：多工具调用的并行执行 + 结果配对

模型一次可能调多个工具（同时读两个文件）。现在 `for...await` 是串行（一个跑完才跑下一个），慢。

并行用 `map` + `Promise.all`，**靠数组下标配对，不靠完成顺序**：
```js
const toolResults = await Promise.all(
  response.tool_calls.map(async (toolCall) => {   // map 按原顺序
    const tool = tools.find((t) => t.name === toolCall.name);
    return tool ? await tool.invoke(toolCall.args) : `错误: 找不到工具 ${toolCall.name}`;
  }),
);   // 结果顺序 = tool_calls 顺序，不管谁先完成
response.tool_calls.forEach((tc, i) =>            // 按下标配对 push
  messages.push(new ToolMessage({ content: toolResults[i], tool_call_id: tc.id }))
);
```
`Promise.all` 保证返回数组顺序 = 输入顺序，所以 `toolResults[0]` 一定是第一个 toolCall 的结果，用 index 配对 id。

```
串行：A(2s)→B(2s)→C(2s) = 6s
并行：A、B、C 同时跑   = 2s（取最慢的）
```

---

## 概念辨析

### error 事件 vs close 事件（spawn）

| | error 事件 | close 事件 |
|---|---|---|
| 何时触发 | 进程**没起来**（spawn 本身失败） | 进程结束 **且** stdio 流都关闭 |
| 触发顺序 | 先（如果发生） | 后（**无论成功失败都触发**，终结信号） |
| 带退出码 | 不带 | 带 code |
| 本课用法 | 存 errorMsg | 读 errorMsg + 用 code 决定退出 |

两个都要监听：error 负责"失败原因"，close 负责"最终结果"。

### SystemMessage vs HumanMessage

| | SystemMessage | HumanMessage |
|---|---|---|
| 角色 | 岗位职责说明书（角色+通用规则+工具清单） | 这次的具体任务单 |
| 稳定性 | 写死，所有任务共享 | 随任务变，任务结束就没 |
| 放什么 | 通用稳定规则 | 任务特定指令 |
| 类比（前端） | 全局 Provider/Context | 某次路由的 props |

---

## 踩坑提醒

1. **工具找不到不能静默跳过** — `tools.find` 返回 undefined 时，`if (foundTool)` 跳过不 push ToolMessage。下一轮模型看到"我调了工具但没回应"，会反复重试直到 maxIterations。**必须返回错误**：`找不到工具 X，可用工具: ...`，让模型改用正确的工具名。

2. **工具失败要 return 错误，不能只 console.log / 不能 throw** — 只 console.log 模型拿到 undefined 会以为成功；throw 会让 agent 循环崩掉。return 错误字符串，模型看到错误能改参数重试。`readFileTool` 的 catch 一开始就漏了 return。

3. **write_file 的 content 要从参数解构出来** — schema 定义了 `content` 字段，但函数参数只解构 `({ filePath })` 的话，`content` 是 undefined，写出来是空文件还会崩在 `content.length`。要 `({ filePath, content })`。

4. **agent 工具的 stdio 要用 pipe 不用 inherit** — inherit 输出打到屏幕，模型拿不到内容，等于"执行了但看不到结果"，模型只能乱猜。见关键机制二。

5. **SystemMessage 只放通用规则，任务特定指令放 HumanMessage** — 把"App.tsx 要 import App.css"这种 React 专属规则写死在 SystemMessage，换任务后还留着，每轮白发一遍浪费 token，还可能误导模型在不相关任务里强行套用。

6. **`split(" ")` 是玩具解析器** — 遇到带空格/引号的参数（`echo "hello world"`）会断。给 agent 跑命令时用参数数组 + `shell: false` 更安全（还能防注入）。

7. **`shell: true` 是命令注入大门** — 模型生成的命令若直接拼进 shell，一条 `ls; rm -rf ~` 就能清家目录。agent 场景尤其危险。

---

## 下一步

1. **把工具执行改成并行** — 用 `map` + `Promise.all` + `forEach` 按下标配对，替换 `mini-cursor.mjs` 第 72-83 行的串行 for 循环。多工具调用时能快几倍。

2. **把 `execute_command` 的 stdio 从 inherit 改成 pipe** — 监听 `child.stdout` 的 `data` 事件收集输出，resolve 回模型。改完 agent 才能真正"看到"命令输出，基于内容做决策。

3. **给 `execute_command` 加安全防护** — 命令白名单（只允许特定命令）或危险命令确认机制（`rm`/`sudo` 先问人）。一旦 agent 能跑命令，注入风险就从理论变现实。
