# ATLAS 需求规范化（v2.1）

把用户的自然语言，转成**可逐条勾选确认**的规范要求，最后输出一份 JSON 交给下一个页面。

- 三个问题：商品类型 → 硬性约束 → 零件拆解
- 所有 AI 输出走**预设函数**（function calling + 严格 JSON Schema 校验）
- 每轮结果在弹窗中逐条列出，**点击卡片切换选中，边框高亮表示生效**
- 弹窗底部固定三个动作：拒绝全部重来 / 保留已选重来 / 保留已选继续
- 完成后 JSON 写入 `window.__REQUIREMENT_PAYLOAD__`、`localStorage`，点「进入下一阶段」交接给 `next.html`

零依赖：Node 原生 `http` + 原生前端，不需要 `npm install`。

## 版本

- **v2.1（当前）**
  - 第二页标题直接显示第一页的硬约束，逐条悬停 / 聚焦可看条件与基线达标状态；
  - 用户自配方案按当前顺序显示「用户自配 1/2/3…」，删除中间方案后自动顺连；
  - 对比矩阵左侧零件列缩到 68px（原宽度的约三分之一），模块名左对齐；
  - 打包名从 `requirement-intake-v2.1.zip` 开始。
- **v2.0**：第二页方案配置与对比，含系统推荐、用户自配、28×4 零件库和对比门槛。


## 启动

```bash
cd requirement-intake-v2
node server.mjs
# 打开 http://127.0.0.1:43125
```

默认端口 `43125`，可用 `PORT` / `HOST` 覆盖。

## 公网访问（Cloudflare Tunnel，可选）

不需要把代码上传到 Cloudflare —— 用隧道把本机服务映射成一个 https 地址，`data/` 仍然留在这台电脑：

```powershell
# 窗口 1：先跑服务
node server.mjs

# 窗口 2：开隧道
.\start-tunnel.cmd
# 等价于 tools\cloudflared.exe tunnel --url http://127.0.0.1:43125 --no-autoupdate
```

终端会打印一个 `https://<随机名>.trycloudflare.com`，手机 / 别的电脑直接打开即可。

注意：

- 这是 cloudflared 的 **quick tunnel**：地址每次启动都会变，Cloudflare 不保证可用性；要固定域名需要账号 + 命名隧道（`cloudflared tunnel create` + DNS 绑定）
- 服务必须保持运行；电脑休眠、断网或关掉隧道窗口，链接立即失效
- **目前没有访问密码**：拿到链接的人可以新建身份码、读写产品、消耗你的 AI 额度，只发给自己人
- 走隧道时所有人共享同一个出口 IP，限流按 `CF-Connecting-IP` 区分（已处理），仍建议别把链接公开

## 身份码与产品保存

打开页面先填**身份码**（2–32 位字母 / 数字 / 下划线 / 短横线 / 中文，统一小写）：

- 身份码对应的文件夹**已存在** → 提示「是否登录」
- **不存在** → 提示「是否创建」，创建时建目录并写入 `identity.json`

每个身份码固定对应本地一个文件夹（默认在项目根目录）：

```
data/
  alice/
    identity.json
    untitled1.json
    云台方案A.json
```

三个问题都确认后进入**命名环节**：默认名从 `untitled1` 开始按已有文件顺延（`untitled2`、`untitled3`…），保存后 JSON 写入该身份码目录。

右上角「我的」：

- 显示当前身份码、本地文件夹、已保存数量
- 列出历史产品（名称 / 保存时间 / 零件数 / 层级），点一行即把该 JSON 读回页面，直接恢复成完成状态
- 底部「切换身份」退出当前身份，回到身份码输入

说明：

- **刷新页面不清缓存**：进度、身份码、登录态都会保留（sessionStorage 存活标记 + 服务端会话），刷新后直接回到原来的位置
- **关闭标签页 / 窗口后重新打开才清空**：缓存（localStorage 里本应用的所有键）与登录态一起清掉，回到身份码入口；已保存到文件夹里的产品不受影响
- **「退出登录」仍然清空缓存**并回到身份码入口（主动退出，与关闭同义）
- 同一浏览器开多个标签页时互相识别，不会因为开新标签页把正在用的进度清掉
- 保存接口需要登录态（内存 Session + HttpOnly Cookie），重启服务后同样需要重新输入一次身份码
- 服务端只暴露相对于项目的路径，Key 与文件系统绝对路径不会下发给前端
- 存放位置可用 `ATLAS_DATA_DIR` 覆盖，例如 `ATLAS_DATA_DIR=D:\atlas-data node server.mjs`；目录结构说明见 `data/README.txt`

## 接入真实 AI（只改一个文件）

编辑项目根目录的 **`ai-config.env`**，填好 Key 和地址并保存：

```ini
AI_API_KEY=sk-...
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat
```

**保存后刷新页面即生效，不需要重启服务。** 常用端点：

| 服务 | `AI_BASE_URL` | `AI_MODEL` |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` / `deepseek-reasoner` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` / `gpt-4o` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 本地 vLLM / Ollama | `http://127.0.0.1:8000/v1` | 你部署的模型名 |

- 键名大小写不敏感，`api_key` / `url` / `model` 也能识别；支持引号、`:` 分隔与 `#` 注释。
- 取值优先级：`ai-config.env` > `.env` > 进程环境变量 > 内置默认值。
- 清空 `AI_API_KEY` 即回到 **mock 模式**：本地规则模拟同样的双输出，全流程可演示。
- 端点写错时右上角徽标显示「配置错误 · 检查 ai-config.env」，接口返回 503 并说明原因，不会静默降级。
- API Key 只在服务端读取，`/api/config` 不会下发 Key。

右上角徽标随之切换：

| 状态 | 徽标 |
| --- | --- |
| 联网 | `DeepSeek · deepseek-chat`（来源 · 模型） |
| 本地 | `MOCK · 本地预设函数` |
| 配置有误 | `配置错误 · 检查 ai-config.env` |

> 旧版 `.env` 仍然可用（适合部署时用环境变量），内容与 `ai-config.env` 相同。


## 一次请求的双输出

`POST /api/normalize`

```json
{ "questionId": "parts", "text": "拆到零件级…", "context": {...}, "carryOver": [...] }
```

响应同时包含：

| 字段 | 含义 |
| --- | --- |
| `reply` | AI 面向用户的自然语言，前端**原样展示**，不二次改写 |
| `result` | 预设函数返回并校验后的结构化 JSON |
| `functionName` | 本次调用的预设函数 |
| `warnings` | 归一化过程中的修正提示（如重复编号被改名） |

预设函数：

| 问题 | 函数 | 输出 |
| --- | --- | --- |
| Q1 商品类型 | `submit_product_type` | 1 个主类型 + 最多 2 个备选（单选） |
| Q2 硬性约束 | `submit_hard_constraints` | 完整约束集合（多选，默认不选） |
| Q3 零件拆解 | `submit_parts` | 从表1 预设里选模块/零件（L1 固定、L2/L3 二选一、L3 全覆盖） |

真实模型若只返回工具调用、没有自然语言，会再发一次"只写回复"的请求补齐；仍然失败则整次请求报错，不会展示半成品。

## 表1 查看页

页面右下角的「表1 v2.0.0 · 7 个模块 / 28 个零件 ↗」是超链接，点开 `table1.html`：

- 直接渲染 `GET /api/table1`（`presets/table1.json` 原文），不复制数据，改表后刷新即同步；
- 列出商品类型（目前只有 `h3` 手持云台）、L2 模块与 L3 零件（含编码、用量、说明）、拆解层级（L1–L3）、约束维度、预设函数，以及文件开头的「格式与编码」规则；
- 右上角「原始 JSON ↗」可看接口原文。

### 表1 v2 的编码与选择规则

| 层 | 编码 | 例子 | 含义 |
| --- | --- | --- | --- |
| L1 | 商品类型 id | `h3` | 整机，永远包含、不可取消，且**不覆盖**下级 |
| L2 | `<L1>-<模块缩写>` | `h3-cam` | 模块，选中即代表整块采购，其下 4 个零件视为已覆盖并从清单隐藏 |
| L3 | `<L2>-<两位序号>` | `h3-cam-01` | 零件，只在所属模块被取消勾选时展开，并锁定为已选 |

- AI 只能返回表1 里存在的 code，自造编码会被丢弃并写入 `warnings`；
- 同一模块内 L2 与 L3 二选一，不允许上下重合（同时出现时保留零件）；
- 每个 L3 必须被覆盖：要么选它的 L2，要么直接选该 L3；只选部分零件会自动补齐其余零件；
- L4（材料 / 工艺级）自 v2.0.0 起暂时停用，`bomLevel` 只接受 `L1 / L2 / L3`。

## 选择与重来语义

- **Q1**：单选，默认选中 AI 主类型。
- **Q2**：默认全部不选，逐条勾选才生效。
- **Q3**：L1 固定选中；默认 7 个模块全部整选。取消某个模块会立刻展开它的 4 个 L3 并锁定为已选，重新勾选模块即收回；L2/L3 不允许同时选中，L3 不允许缺项。
- **保留已选，重新提问**：已选条目全部保留；下次弹窗中即使 AI 没有重新返回它们，也会以虚线卡片重新出现并保持选中。
- **拒绝全部，重新提问**：清空本题的 AI 结果、已选条目和输入框。
- **保留已选，继续**：至少选中 1 条才能继续；本题打上已完成标记，进入下一问。

## 输出 JSON

完成三个问题后，摘要卡上会直接提供「进入下一阶段」：

```js
window.__REQUIREMENT_PAYLOAD__ // 当前页完整载荷
// 或
JSON.parse(localStorage.getItem("atlas.requirement-intake.v2.<身份码>")).payload
```

结构（节选）：

```jsonc
{
  "schemaVersion": "atlas.requirement-baseline/v2",
  "status": "complete",
  "result": {
    "productType": { "presetId": "h3", "name": "h3 手持云台" },
    "constraints": [{ "dimension": "weight", "operator": "<=", "value": "800", "unit": "g" }],
    "parts": [
      { "code": "h3", "name": "h3 手持云台", "level": "L1", "qty": 1 },
      { "code": "h3-cam-01", "name": "相机模组", "level": "L3", "qty": 1, "parentCode": "h3-cam" },
      { "code": "h3-pit", "name": "俯仰轴总成", "level": "L2", "qty": 1, "parentCode": "h3" }
    ],
    "bomLevel": "L3",
    "bomLevelName": "零部件级"
  },
  "questions": [{ "id": "product_type", "rounds": 2, "selectedCount": 1 }],
  "handoff": { "target": "next-page" }
}
```

`parts` 里只写用户最终勾选的条目（L1 + 整选模块 + 展开的 L3），不额外展开整选模块的零件；`bomLevel` 取所选条目里的最深层级（有 L3 即 L3，否则 L2）。

### 保存到「我的」

命名保存后，同一份 JSON 写入 `data/<身份码>/<产品名>.json`，并追加四个字段：

```jsonc
{
  "projectName": "云台方案A",
  "savedAt": "2026-10-30T14:28:48.000Z",
  "savedBy": "alice",
  "storage": { "folder": "alice", "file": "云台方案A.json" }
}
```

文件名里的 `\ / : * ? " < > |` 会替换成 `_`，重名自动加 `-2` / `-3` 后缀；内容仍是完整的 handoff 载荷。

## 进入下一阶段（交接给下一页面）

摘要卡主按钮「进入下一阶段」不再下载文件，而是把整份 JSON 交给下一页面：

1. 浏览器 `POST /api/handoff`（`{ name, payload }`）；
2. 服务端写入 `data/.handoff/<令牌>.json`，返回 `next.html?handoff=<令牌>`；
3. 浏览器跳到该地址；
4. `next.html` 用 `GET /api/handoff/<令牌>` 读回同一份 JSON，挂到 `window.__STAGE2_PAYLOAD__`，进入第二页的方案配置。

约束：

- 交接内容只有生成它的身份码（同一个登录 Cookie）能读回，链接被转发也读不到；
- 令牌是 32 位随机十六进制，12 小时后过期，过期后提示回到需求页重进；
- 第一页顶部按钮已改为「进入下一阶段」，JSON 下载/复制移到了第二页的「需求 JSON」弹窗；
- 第二页直接打开会提示缺少令牌；本地预览用 `next.html?demo=1`。

## 第二页：方案配置与对比

第二页在 `next.html`，接收第一页的 JSON 后进入：

- **左栏 · 用户自配器**：按表1 的 7 个模块 / 28 个零件类型列出；点零件类型展开 4 个型号（标准 / 轻量 / 增强 / 旗舰），点「加入」写入当前用户方案。
- **两个入口**：
  - **从系统推荐开始自配**：复制系统基线（CSV 原始 BOM）成一个新的「用户自配 1」，可逐项替换；
  - **从零开始自配**：创建一个全空的「用户自配 N」，必须填满 28 个零件类型。
  - 每点一次，新列追加到对比矩阵最右侧；可删除、可清空。
- **中栏 · 对比矩阵**：列 = 系统推荐（只读）+ 用户自配 1/2/3…；行 = 模块 / 零件类型；格子 = 该方案选中的零件名，悬停显示单价、重量、交期等核心参数。左侧零件列固定 68px，模块名左对齐；用户方案删除中间一列后按当前顺序重新编号。
- **标题 · 硬约束**：标题位置直接列出第一页的硬约束，每条都可悬停 / 键盘聚焦查看完整条件、系统推荐实际值和是否达标；无法自动计算的维度标为「需人工确认」。
- **右栏 · 零件详情**：当前零件参数、责任人、说明，以及预留的「示意模型」空位。
- **对比门槛**：至少一个用户方案，且所有用户方案的 28 个零件类型都填满，`开始对比` 才可用；对比后显示每个方案的成本 / 重量 / 最长交期、硬条件满足情况，并高亮差异零件。
- **硬条件校验**：从第一页的 `result.constraints` 读取，目前自动校验 **重量（weight）/ 成本（budget）/ 交期（lead_time）**；其他维度（如 IP54、认证）会在对比结果中标注「需人工确认」。不满足的方案在列名旁显示 `!`，悬停显示具体条件。
- **结构爆炸 / 周期风险 / 人员协作**：三个 Tab 目前是占位页，只保留 `window.STAGE2_HOOKS.<id>.mount(el, ctx)` 接口，不渲染实质内容。

零件库在 `public/data/h3-parts.json`：

- 28 个零件类型 × 4 个型号；`variants[0]` 是系统推荐基线；
- 每个型号有 `price / weight / leadTime / risk / material / spec / params / description`；
- 文件开头的 `$comment` 就是格式说明；改这个文件不需要改前端，新增类型时 `code` 必须与 `presets/table1.json` 的 L3 编码一致；
- 页面结构（模块、零件名、数量）仍以 `GET /api/table1` 为准，零件库只提供型号与参数。

### 零件表格的位置

页面中间的「方案对比」就是零件表格（DOM 为 `#matrix`，位于左栏用户自配器和右栏零件详情之间）：

- 行 = 表1 的 7 个模块 / 28 个零件类型，模块行单独分隔；
- 列 = 系统推荐 + 用户自配 1/2/3…；
- 单元格 = 该方案为这个零件类型选中的型号名，悬停看单价、重量、交期；
- 底部「合计」行 = 成本 / 重量 / 最长交期 / 硬条件结果。

对应实现：`public/next.js` 的 `renderMatrix()` / `buildColumnHeader()`，样式在 `public/next.css` 的 `.s2-matrix` 段。

## 测试

校验脚本单独放在 `../requirement-intake-v2-checks/`，应用目录里不带测试与截图：

```bash
cd ../requirement-intake-v2-checks

node --test                        # 单元测试：契约 / mock 管线 / 配置热加载 / 身份码 / 交接存储 / 第二页零件库（41 项）
node scripts/browser-check.mjs     # mock 模式端到端（身份码 → 三问 → 命名 → 我的 → 读取 → 进入第二页 → 自配 → 对比）
node scripts/live-check.mjs        # 联网模式验收（配合 stub-ai，无需真实 Key）
```

浏览器验收使用 Chrome DevTools Protocol：

```bash
chrome --headless=new --remote-debugging-port=9224 --user-data-dir=%TEMP%\atlas-v2-chrome about:blank
```

建议用独立实例 + 临时数据目录跑验收，避免污染真实 `data/`：

```powershell
# PowerShell
$env:PORT="43126"; $env:ATLAS_DATA_DIR="C:\tmp\atlas-e2e"; $env:AI_MOCK="1"; node server.mjs
cd ../requirement-intake-v2-checks; $env:APP_URL="http://127.0.0.1:43126/"; node scripts/browser-check.mjs
```

联网链路可以在没有真实 Key 的情况下验收 —— `scripts/stub-ai.mjs` 是一个本地 OpenAI 兼容假服务，返回带 `【STUB】` 前缀的合法函数调用，用来证明请求确实走了 HTTP：

```bash
node scripts/stub-ai.mjs                        # http://127.0.0.1:43199/v1
AI_CONFIG_FILE=/tmp/live.env APP_URL=http://127.0.0.1:43127/ node scripts/live-check.mjs
```

`live-check` 只改 `AI_CONFIG_FILE` 指向的临时配置（默认 `ai-config.env`），结束时自动还原；会断言：徽标变成「来源 · 模型」、`/api/config` 不含 Key、回复来自 stub、表1 链接可打开、非法端点显示配置错误、还原后回到 MOCK。

## 文件

```
server.mjs                  HTTP 服务、静态资源、/api/normalize、/api/table1、身份码、产品与交接接口
ai-config.env               联网 AI 配置（填 Key + URL，保存即生效）
启动.cmd / start.cmd        双击启动：检查 Node、启动服务、打开浏览器
start-tunnel.cmd            一键启动 Cloudflare Tunnel（首次运行自动下载 cloudflared，不占仓库空间）
data/                       本地数据目录：<身份码>/<产品名>.json；data/.handoff/<令牌>.json（交接缓存）
lib/ai-config.mjs           配置读取、端点归一化、来源名推断
lib/ai.mjs                  OpenAI 兼容调用、双输出解析、重试
lib/identity-store.mjs      身份码校验、目录登录/创建、产品 JSON 存取
lib/handoff-store.mjs       交接令牌：写入 / 读回 / 过期清理
lib/preset-functions.mjs    三个预设函数的 Schema 与严格校验
lib/mock-normalizer.mjs     无 key 时的规则模拟（从表1 预设里选模块/零件）
lib/table1.mjs              表1 / 问题集读取
presets/table1.json         表1（可整体替换，契约不变）
presets/questions.json      三个问题
public/                     前端（原生 JS，无构建；next.html 第二页、table1.html 表1 查看页）
public/data/h3-parts.json   第二页零件库：28 类 × 4 型号（含格式注释）
public/data/demo-requirement.json  第二页 ?demo=1 的本地演示需求
public/next.js              第二页：用户自配、对比矩阵、硬条件校验、Tab 接口
public/next.css             第二页样式（与第一页同一套深色设计语言）
```

校验脚本、单元测试与截图都不在这个目录，统一放在 `../requirement-intake-v2-checks/`（见该目录的 README）。
