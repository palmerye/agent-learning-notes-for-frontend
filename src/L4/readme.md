# 第 4 课：MCP —— 让工具跨进程、可复用、可组合

> 背景：前端工程师转 agent 开发。L2/L3 学了「本地 tool」，这课学 MCP——把 tool 做成跨进程、标准化的能力包。

---

## 1. 核心认知

### 1.1 MCP 和 tool 不是同一层的东西

新手最容易混：「MCP vs tool 是对立的两个东西吗？」**不是**。

- **tool（工具）**：是一种**能力类型**——「模型能调用的函数」。不管这函数从哪来，都叫 tool。
- **MCP**：是一套**协议/标准**——规定「工具怎么被发现、怎么调用、参数怎么传」。它是 tool 的**一种交付方式**，不是 tool 的替代品。

前端类比：
- tool = 「组件」这个概念
- MCP = 「npm 包 + ES Module 规范」——规定组件怎么打包、怎么 import、怎么暴露 API

所以准确说法：**MCP 是「跨进程、标准化地交付 tool 的一种方式」**。你用 MCP 拿到的 `query_user`，对模型来说**还是一个 tool**，只是它的实现在另一个进程里。

### 1.2 MCP 跨进程，是铁证就在代码里

[langchain-mcp-test.mjs:17-20](../L4/langchain-mcp-test.mjs#L17-L20) 的 client 配置：

```js
"my-mcp-server": {
  command: "node",                                    // ← 用 node 启动一个进程
  args: ["/Users/.../my-mcp-server.mjs"],            // ← 跑的是这个 server 文件
},
```

`command: "node"` + `args: [server.mjs 路径]` = **spawn 一个子进程**。和 L3 的 `node_exec.mjs` 里 `spawn("ls", ...)` 是同一类操作，只不过这里 spawn 的是 `node my-mcp-server.mjs`。

server 端 [my-mcp-server.mjs:86-87](../L4/my-mcp-server.mjs#L86-L87)：

```js
const transport = new StdioServerTransport();   // ← 用「标准输入输出」当通信通道
await server.connect(transport);
```

两个进程之间没法直接调函数，只能靠「管道」传字节，所以用 **JSON-RPC**（一种基于 JSON 的远程调用协议）在 stdio 上互发消息。

---

## 2. 逐段拆解

### langchain-mcp-test.mjs（client 端 / agent 进程）

**① 导入与初始化（第 1-13 行）**

- `ChatOpenAI`：和 OpenAI 兼容接口通信的客户端。
- `MultiServerMCPClient`：MCP client，能同时连多个 server（见下「多 server 架构」）。
- `chalk`：终端彩色输出。
- model 配置走 `.env`（`MODEL_NAME` / `API_KEY` / `BASE_URL`）。

**② 配置并连接 MCP server（第 15-22 行）**

```js
const mcpClient = new MultiServerMCPClient({
  mcpServers: {
    "my-mcp-server": {
      command: "node",
      args: [".../my-mcp-server.mjs"],
    },
  },
});
```

- `mcpServers`（复数）——能配多个 server，每个 spawn 一个子进程。
- `command` + `args` = 怎么启动那个 server 子进程。

**③ 发现工具 + 绑定到模型（第 24-25 行）**

```js
const tools = await mcpClient.getTools();
const modelWithTools = model.bindTools(tools);
```

- `getTools()`：通过 stdio 发一条 `tools/list` 的 JSON-RPC 消息问 server「你有哪些工具」，server 回清单（`query_user` + 它的 schema）。
- `bindTools`：和 L2 一样，告诉模型「这次对话可以用这些工具」。

**④ 读取资源（第 27-35 行）—— 本课最易混的一段**

```js
const res = await mcpClient.listResources();   // 列出所有 server 有哪些资源

let resourceContent = "";
for (const [serverName, resources] of Object.entries(res)) {   // 遍历每个 server
  for (const resource of resources) {                           // 遍历该 server 的每个资源
    const content = await mcpClient.readResource(serverName, resource.uri);  // 读单个资源
    resourceContent += content[0].text;                         // 把文本拼起来
  }
}
```

- `listResources()`：发 `resources/list` 消息，拿到按 server 名分组的资源清单。
- 两层循环：外层遍历 server（多 server 架构），内层遍历每个 server 的资源。
- `readResource(serverName, uri)`：真正读资源内容，对应 server 端 `registerResource` 注册的回调。
- `content[0].text`：MCP 资源返回数组结构，取第一个的 `text` 就是正文。
- 拼成 `resourceContent` 后，第 39 行塞进 `new SystemMessage(resourceContent)` 当背景知识。

**⑤ agent 循环（第 37-74 行）**

和 L2/L3 的循环结构一致，但有两个改进点：

- **`maxIterations` 兜底**（第 37、68-73 行）：循环跑满 30 次还没结束就强制停，防止 agent 死循环。这是 L2/L3 手写版没做的健壮性。
- **工具调用是串行 `for` 而非 `Promise.all`**（第 54-65 行）：和 L2 的并行 `map` 不同，这里用串行 `for...of`。简单但慢——多个工具调用会一个一个等。

**⑥ 执行与收尾（第 76-77 行）**

```js
await runAgentWithTools("查⼀下⽤户 002 的信息");
await mcpClient.close();   // ← 别忘了关，否则子进程残留
```

### my-mcp-server.mjs（server 端 / 子进程）

**① 导入与数据（第 1-22 行）**

- `McpServer`：MCP server 实现。
- `StdioServerTransport`：用 stdio 当通信通道。
- `z`：zod，和 L2 一样给工具入参定结构。
- `database`：内存假数据库（3 个用户）。

**② 注册工具 `query_user`（第 30-62 行）**

```js
server.registerTool(
  "query_user",
  {
    description: "查询数据库中的用户信息……",
    inputSchema: { userId: z.string().describe("用户 ID……") },
  },
  async ({ userId }) => { ... 返回 { content: [{ type: "text", text: ... }] } },
);
```

- `registerTool(名字, 元信息, 执行函数)` —— 和 L2 的 `tool(函数, 元信息)` 参数顺序相反，但本质一样：名字 + 描述 + schema + 执行逻辑。
- 返回值结构是 MCP 协议规定：`{ content: [{ type: "text", text: ... }] }`，比 L2 的直接返回字符串多套了一层——因为 MCP 要跨进程序列化，结构必须规范。

**③ 注册资源 `docs://guide`（第 64-84 行）**

```js
server.registerResource(
  "使用指南",       // 名字
  "docs://guide",   // URI（资源的唯一标识，类似 URL）
  { description: "...", mimeType: "text/plain" },
  async () => { return { contents: [{ uri, mimeType, text: ... }] }; },
);
```

- 资源用 **URI** 标识（`docs://guide`），像 URL 一样唯一。
- 回调返回 `contents` 数组，每个元素带 `uri` + `mimeType` + `text`。

**④ 启动（第 86-87 行）**

```js
const transport = new StdioServerTransport();
await server.connect(transport);
```

挂到 stdio 通道，开始等 client 的 JSON-RPC 消息。

---

## 3. 关键机制详解

### 3.1 资源 vs 工具：确定性时机不同（本课最核心）

| | 资源（Resource） | 工具（Tool） |
|---|---|---|
| 例子 | `docs://guide` 使用指南 | `query_user` 查用户 |
| 谁决定用 | **程序**主动读，提前塞给模型 | **模型**根据上下文按需调 |
| 内容何时确定 | **对话开始前**就定死（server 注册时） | **对话进行中**、依赖用户输入才确定 |
| 触发时机 | 静态、对话前 | 动态、对话中 |
| 怎么喂给模型 | 塞进 `SystemMessage` 当背景 | `ToolMessage` 按需喂回 |
| 类比 | 开机就带的背景资料 | 模型按需调用的函数 |

**为什么 `query_user` 不能像资源那样提前读？** 因为它要查「用户 002」，这个「002」要等用户说「查用户 002」才知道——提前读的时候还不知道查谁。而使用指南的内容，server 一注册就定死了，谁来说都一样，所以能提前塞。

> **资源 = 对话开始前就确定的内容（静态背景）；工具 = 对话进行中、依赖用户输入才确定的内容（动态能力）。**

这正好串上之前学的：资源提前塞进 SystemMessage = **动态拼装 SystemMessage 片段**，就是「skill ≈ 可动态拼装的 SystemMessage 片段」的活例子。

### 3.2 stdio 通信的隐患：stdout 是协议专用通道

`StdioServerTransport` 靠 **stdout 传 JSON-RPC 消息**。如果 server 端 `query_user` 里 `console.log` 了调试信息，这些信息**也走 stdout**。

agent 在 stdout 上等的是一条条 JSON-RPC 消息（`{"jsonrpc":"2.0","result":...}`），结果收到：

```
调试信息：开始查询用户 002        ← 不是合法 JSON
调试信息：数据库连接成功
{"jsonrpc":"2.0","result":{...}}  ← 真消息混在里面
调试信息：查询完成
```

agent 一解析，前面几行非合法 JSON → **解析失败 / 协议错乱**，整个通信崩了。

**隐患**：stdout 是「单通道、混用」的——既要传协议消息，又是 `console.log` 的默认出口。一旦混进非协议内容，JSON-RPC「一条消息 = 一段完整 JSON」的约定就被打破。

**解决**：
1. server 端 `console.log` 应该走 **stderr**（不参与 JSON-RPC，client 可单独收、不干扰协议）。
2. 或用日志文件，彻底不碰 stdio。
3. MCP 还有 `StreamableHTTPTransport` 等其他传输方式，能避开混用问题。

> **stdio 通信下，stdout 是 JSON-RPC 专用通道。server 业务代码别往里写东西，调试输出走 stderr。**

### 3.3 多 server 架构：从「单进程命令」到「能力生态」

`MultiServerMCPClient` 的 `mcpServers`（复数）允许同时连多个 server：

```js
mcpServers: {
  "my-mcp-server": { ... },      // 查用户
  "github-server": { ... },      // 操作 GitHub
  "filesystem-server": { ... },  // 读写文件
  "postgres-server": { ... },     // 查数据库
}
```

一次配置，agent 同时拥有查用户 + 操作 GitHub + 读写文件 + 查数据库的能力——每个来自一个独立的 server 子进程。

和 L3 `node_exec.mjs` 对比：

| | L3 `node_exec.mjs` | L4 MCP 多 server |
|---|---|---|
| spawn 几个 | **1 个**（跑完就结束） | **N 个**（每个 server 一个常驻子进程） |
| 通信 | 单向：spawn → 等输出 | 双向：持续 JSON-RPC 对话 |
| 能力来源 | 自己写死的命令 | 每个 server 独立暴露，**可来自第三方** |
| 复用 | 只你能用 | 任何 MCP client 都能用 |

架构升级：**从「单进程、一次性命令」到「多进程、常驻、可组合的能力生态」**。agent 不用自己实现所有功能，而是「插拔」各种 MCP server 拼出能力——像前端 `npm install` 多个包各管一摊。

### 3.4 跨进程调用的完整路径

```
模型说「我要调 query_user，参数 userId=002」
  → agent 进程
  → 通过 stdio 发 JSON-RPC 消息 {"method":"tools/call", ...} 给 server 子进程
  → server 子进程执行真正的查数据库逻辑
  → 结果通过 stdio 发回来
  → agent 进程把结果喂给模型
```

中间跨了一次进程边界，还经过序列化（参数变 JSON 字符串传过去，结果变 JSON 传回来）。

---

## 4. 概念辨析

### 4.1 本地 tool vs MCP tool

| | 本地 tool（如 L2 `read_file`） | MCP tool（如 `query_user`） |
|---|---|---|
| 实现位置 | **同进程**，就是你的一个函数 | **另一个进程**，server 里 |
| 怎么调用 | 直接 `await fn(args)`，函数调用 | 通过 stdio 发 JSON-RPC，跨进程 |
| 参数传递 | JS 对象直接传 | 序列化成 JSON 字符串传过去 |
| 怎么发现 | 手动 `tools.push(...)` | `mcpClient.getTools()` 自动发现 |
| 谁写的 | 你自己 | 可以是别人/第三方 |
| 启动方式 | import 就能用 | client 要先 spawn server 进程 |
| 性能 | 快（函数调用） | 慢（跨进程 + 序列化） |
| 解耦 | 紧耦合在项目里 | 独立进程，可被多个 client 复用 |

### 4.2 spawn 家族（L3 学的，L4 是其进阶）

| | `exec` | `spawn` | `execFile` |
|---|---|---|---|
| 命令形式 | 整条命令字符串 | 命令 + 参数数组 | 可执行文件 + 参数 |
| 是否经 shell | 是 | 可选（`shell: true`） | 否 |
| 输出 | 一次性 buffer | 流式 | 一次性或流式 |
| L4 用法 | — | MCP client 用它 spawn server | — |

L3 的 `spawn` 是「一次性跑命令」；L4 把 spawn 做成了「spawn 出常驻 server + 持续 JSON-RPC 对话」。**L3 的 spawn 是 L4 MCP 跨进程的基石。**

### 4.3 MCP 通信协议：JSON-RPC

- JSON-RPC = 基于 JSON 的远程调用协议，规定「请求长什么样、响应长什么样」。
- 消息例子：`{"jsonrpc":"2.0","method":"tools/call","params":{...},"id":1}`
- 两个进程靠它在 stdio 上互发，谁也不关心对方什么语言写的。

---

## 5. 踩坑提醒

1. **stdout 是 JSON-RPC 专用通道** — server 里任何 `console.log` 都会污染协议解析。调试输出走 stderr。
2. **`content[0].text` 假设资源只返回一段文本** — 多段/多类型（如图片）会丢内容。生产里要遍历 `content` 数组。
3. **资源内容进 SystemMessage = 每次对话都占 token** — 资源一大就费钱，这正是 MCP 用「工具按需调」补充的原因。
4. **`mcpClient.close()` 别忘** — 否则 server 子进程残留，占内存。
5. **MCP 返回值结构比本地 tool 多套一层** — `{ content: [{ type, text }] }`，因为要跨进程序列化，结构必须规范。不能像 L2 那样直接返回字符串。
6. **`registerTool` 和 `tool()` 参数顺序相反** — MCP 是 `(名字, 元信息, 函数)`，LangChain 是 `(函数, 元信息)`。别混。
7. **跨进程有代价** — 慢、复杂、要序列化。高频简单工具本地写更划算；要复用/跨语言/给生态用的才包成 MCP server。

---

## 6. 和前面课程的关系

```
L2  本地 tool（read_file）         同进程函数，快但只你能用
   │
   ▼
L3  spawn 执行命令（node_exec）     一次性跨进程，跑完就结束
   │
   ▼
L4  MCP（query_user 跨 server）    常驻跨进程 + JSON-RPC，可复用、可组合、跨语言
```

L2 学「tool 是什么」，L3 学「spawn 跨进程的底层」，L4 把两者合成「跨进程、标准化的 tool 交付」。

---

## 7. 下一步

- 给 server 加一个「写文件」工具，和 `query_user` 一起暴露给 agent
- 把 client 的串行 `for...of` 工具调用改成 `Promise.all` 并行（对照 L2 的写法）
- 试一下同时连两个 server（比如再加一个 filesystem server），体验多 server 组合
- 把 `console.log` 调试信息改走 stderr，验证不干扰 JSON-RPC
