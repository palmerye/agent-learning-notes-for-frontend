# 第 1 课：hello-langchain — 跑通第一个 LLM 调用

> 16 行代码，第一次让程序「会说话」。前端工程师转 Agent 开发的起点：把 LLM 当成一个可调用的远程服务，跑通最小闭环。

源码：`src/L1/hello-langchain.mjs`

---

## 核心认知

整段代码只有一件事容易卡，但卡住就后面全乱：**`model.invoke()` 返回的不是字符串，是一个结构化对象（`AIMessage`）。**

前端直觉会直接得错结论：我们太习惯「函数返回我要的数据」——`fetch(url)` 在前端用惯了 `.then(r => r.json())`，但很多人写 `axios.get()` 时会以为返回值就是 body。这里更极端：`invoke('hi')` 看起来像「问一句、答一句」，直觉是返回一句字符串。**错。** 它返回一个 `AIMessage` 对象，真正的回答文本在 `.content` 里，对象上还挂着 `usage`（token 计费）、`response_metadata`（模型名、finish_reason）、`tool_calls`（要不要调工具，L2 会用到）等字段。

类比：`invoke()` 的返回值更像 `fetch()` 的 `Response`——不是最终内容，是「这次通信的完整封装」，body 要再取一层（`.content`）。第 16 行 `console.log(response.content)` 取的就是这一层。

第二个反直觉点：**环境变量是运行时读文件加载的，不是构建期注入的。** 前端用 Vite 时，`import.meta.env.VITE_X` 是构建时被**字面量替换**进打包产物的；而这里第 4 行 `dotenv.config()` 是 Node **运行时**去读 `.env` 文件、把键值写进 `process.env`。顺序很重要：必须先 `dotenv.config()`，后面 `new ChatOpenAI({ apiKey: process.env.API_KEY })` 才读得到值。

---

## 逐段拆解

代码按逻辑切成 4 段。

### ① 导入（第 1-2 行）

```js
import dotenv from 'dotenv'
import { ChatOpenAI } from '@langchain/openai'
```

- `dotenv`：把 `.env` 文件里的键值对灌进 `process.env` 的工具。
- `ChatOpenAI`：LangChain 里「对接 OpenAI 兼容接口」的客户端类。注意它来自 `@langchain/openai`，不是 `langchain` 主包——LangChain 拆成了一堆子包，按需装。

### ② 运行时加载环境变量（第 4 行）

```js
dotenv.config()
```

在干嘛：读当前目录的 `.env`，把 `MODEL_NAME / API_KEY / BASE_URL` 写进 `process.env`。

为什么这么写：密钥不能写死在代码里（会进 git、会泄露）。放 `.env`（已被 `.gitignore` 忽略），运行时再注入。**这一行必须在第 6 行 `new ChatOpenAI(...)` 之前**，否则构造模型时 `process.env.API_KEY` 还是 `undefined`。

### ③ 构造模型客户端（第 6-12 行）

```js
const model = new ChatOpenAI({
  modelName: process.env.MODEL_NAME,
  apiKey: process.env.API_KEY,
  configuration: { baseURL: process.env.BASE_URL }
})
```

在干嘛：造一个「能跟 LLM 对话」的客户端对象 `model`。

为什么这么写——这里有个分层，详见下一节。一句话：`modelName / apiKey` 是「业务参数」（用哪个模型、用谁的钥匙），`configuration.baseURL` 是「传输参数」（请求往哪个地址发）。分开放是因为它们语义不同：换模型改 `modelName`，走代理/第三方兼容服务改 `baseURL`。

### ④ 调用并取内容（第 14-16 行）

```js
const response = await model.invoke('say hi!你是什么模型？')
console.log('==!==', response.content)
```

在干嘛：发一句话给模型，拿到 `response`（`AIMessage`），打印它的 `.content`。

为什么这么写：

- `invoke` 是 LangChain 对所有模型统一的同步调用入口（L2 会见到它也能传 `messages` 数组）。这里直接传字符串，LangChain 内部会包成一个 `HumanMessage`。
- `await`：网络请求是异步的，等它回来。
- `response.content` 而非 `response`：取正文文本，见「核心认知」。

---

## 关键机制详解

### 机制一：ChatOpenAI 的配置分层（模型参数 vs 客户端配置）

`new ChatOpenAI({...})` 的参数分两层，容易混：

- **顶层（模型/业务参数）**：`modelName`、`apiKey`、`temperature` 等。描述「这次对话本身」——用哪个模型、采样多随机。
- **`configuration`（传输/客户端配置）**：`baseURL`、`headers`、`timeout` 等。描述「HTTP 请求怎么发」——往哪发、带什么头、超时多久。

为什么 `baseURL` 要塞进 `configuration` 而不是顶层？因为 `baseURL` 不是「模型属性」，是「HTTP 客户端属性」。同一个模型（比如 `gpt-4o-mini`）可以从官方发，也可以从代理/第三方兼容服务发——模型没变，变的是「请求往哪送」。LangChain 把它归到 `configuration`，是因为它最终喂给底层 `openai` SDK 的 client 配置，而不是拼进模型参数。

```
new ChatOpenAI({
    modelName,  ────────────►  决定「用哪个大脑」  ──┐
    apiKey,     ────────────►  决定「谁的钥匙」    ──┤  组装成
    configuration: {            决定「请求怎么发」    │  一次 HTTP
      baseURL  ──────────────►  往哪个地址送 ────────┤  请求
      (headers, timeout…)                              │
    }                                                 │
})                                                    ▼
                              POST {baseURL}/chat/completions
                              body: { model: modelName, ... }
                              header: Authorization: Bearer {apiKey}
```

一句话：**模型参数描述「说什么」，传输参数描述「往哪说」。** 分层是为了让换模型和换通道互不干扰。

### 机制二：invoke 的调用链与 AIMessage 返回

`await model.invoke('...')` 这一行背后干了一串事，理解它能解释「为什么返回的是对象不是字符串」：

```
invoke('say hi!')
   │
   │  ① LangChain 把字符串包成 HumanMessage
   ▼
[组装请求] model=modelName, messages=[{role:'user', content:'say hi!'}]
   │
   │  ② 通过 configuration 里的 baseURL + apiKey 发 HTTP
   ▼
POST {baseURL}/chat/completions   ──►  OpenAI 兼容服务
   │
   │  ③ 服务返回 JSON：{ choices:[{message:{content:"...", role:"assistant"}}], usage:{...} }
   ▼
[LangChain 解析]  把 choices[0].message 包成 AIMessage 对象
   │              content = 正文文本
   │              usage   = token 计费
   │              response_metadata = 模型名/finish_reason
   │              tool_calls = 要不要调工具（L2 才用得上）
   ▼
return AIMessage   ←  所以 response.content 才是正文，response 本身是「这次通信的完整封装」
```

关键：HTTP 响应里不只有「回答文本」，还有 token 用量、结束原因、（未来）工具调用意图。LangChain 把它们全打包进 `AIMessage` 一次性还给你，所以返回值是个对象。这跟 `fetch` 返回 `Response`（含 status/headers/body）是同一个设计哲学——**返回「完整响应」而非「只取你要的那部分」**，把决策权留给调用方。

---

## 概念辨析

三个配置项都塞在 `new ChatOpenAI({...})` 里，但语义分层不同：

| 配置项        | 属于哪层  | 控制什么                   | 换它 =       | 前端类比                        |
| ------------- | --------- | -------------------------- | ------------ | ------------------------------- |
| `modelName` | 模型/业务 | 用哪个模型（哪个「大脑」） | 换组件版本   | 选`react@18` 还是 `@17`     |
| `apiKey`    | 传输/认证 | 谁在调、能不能调           | 换登录态     | 请求里的`Authorization` token |
| `baseURL`   | 传输/地址 | 请求往哪个域名发           | 换服务端地址 | `axios.create({ baseURL })`   |

记忆点：`modelName` 是「说什么」，`apiKey`/`baseURL` 是「怎么说、往哪说」。后两者都属传输层，所以 `baseURL` 进 `configuration`，`apiKey` 虽放顶层但本质也是传输凭据。

---

## 踩坑提醒

1. **`response.content` 不是 `response`** — 直接 `console.log(response)` 会打印一大坨 `AIMessage` 元数据（`usage`、`response_metadata`…），正文在 `.content`。这是「核心认知」那条坑的具象表现。
2. **`dotenv.config()` 顺序** — 必须在 `new ChatOpenAI(...)` 之前。放后面，构造模型时 `process.env.API_KEY` 还是 `undefined`，报 401。
3. **`.mjs` 才能顶层 `await`** — 第 14 行的 `await` 直接写在文件顶层，靠的是 ES Module。文件后缀必须是 `.mjs`（或在 `package.json` 设 `"type":"module"`）。CommonJS（`.cjs`/`.js` 无 type）里顶层 `await` 会报 `SyntaxError`，得包一层 `async function main(){...}();`。
4. **`baseURL` 末尾斜杠** — OpenAI 兼容接口对 `https://x/v1` vs `https://x/v1/` 敏感，拼路径可能多/少一道杠导致 404。配代理时先确认服务方要哪种。
5. **`@langchain/openai` 要单独装** — `npm i langchain` 不带 OpenAI 适配，得额外 `npm i @langchain/openai`，否则 `Cannot find module '@langchain/openai'`。
6. **`.env` 要进 `.gitignore`** — 密钥泄露是真实事故源；首次提交前确认 `.env` 没被 `git add`。

---

## 下一步

1. **把字符串换成 `messages` 数组**：试着 `model.invoke([new SystemMessage('你只用中文回答'), new HumanMessage('hi')])`，对比直接传字符串的差别——这是 L2「对话历史 = messages 数组」的入口。
2. **把 `invoke` 换成 `stream`**：`for await (const chunk of model.stream('讲个长点的故事')) console.log(chunk.content)`，看流式输出怎么消费，体会「同步拿整块」vs「流式拿碎片」。
