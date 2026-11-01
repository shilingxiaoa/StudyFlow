# DeepSeek API 备忘（核实于 2026-10-19）

> 来源：官方文档 <https://api-docs.deepseek.com/zh-cn/>。
> **价格与模型随时可能变，动手前再核一次首页定价表。**

---

## 1. 模型（只有两个）

| 模型 ID | 版本 | 上下文 | 最大输出 | 并发 | 图像理解 |
|---|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017 | 1M | 384K | 2500 | ✅ |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M | 384K | 500 | ❌ |

- ❌ **`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 下线**，网上大量老教程仍在用，别照抄。
- 旧名 `deepseek-v4-flash` 等仍可调用，但已路由到 V4.1-Flash，按 Flash 计费。
- `max_tokens` 默认值：非思考 8K / 思考 64K / `reasoning_effort=max` 时 128K。

---

## 2. 端点与认证

| 用途 | URL |
|---|---|
| OpenAI 格式 | `https://api.deepseek.com` |
| Anthropic 格式 | `https://api.deepseek.com/anthropic` |
| Beta（strict tool calls） | `https://api.deepseek.com/beta` |
| Chat 补全 | `POST /chat/completions` |
| 结构化输出（严格） | `POST /responses` |

认证：`Authorization: Bearer ${DEEPSEEK_API_KEY}`
Key 申请：<https://platform.deepseek.com/api_keys>

---

## 3. 思考模式（默认开启，最容易踩坑）

```jsonc
{
  "model": "deepseek-flash",
  "thinking": { "type": "enabled" },   // enabled | disabled，默认 enabled
  "reasoning_effort": "high"           // none | low | high | max，默认 high
}
```

⚠️ **思考模式下 `temperature` 完全无效。** 需要温度控制就必须 `thinking.disabled`。
`top_p` 只在思考模式生效（有效区间 0.95–1.0）；非思考模式固定 1.0，传值被忽略。

推理过程在响应里单独返回 `reasoning_content`；多轮对话时**不要把 `reasoning_content` 回传给 API**（会被忽略）。

---

## 4. JSON / 结构化输出

| 方式 | 端点 | 严格程度 | 说明 |
|---|---|---|---|
| `response_format: {"type":"json_object"}` | Chat Completions | 宽松 | 只保证是合法 JSON，字段全靠 prompt |
| `text.format: {"type":"json_schema", ...}` | **Responses API** | **严格** | 服务端按 schema 约束 |

**用 `json_object` 的三个硬要求：**

1. prompt（system 或 user）中**必须出现 "json" 字样**并给示例
2. `max_tokens` 要给够，否则 `finish_reason: "length"` 截断
3. 官方明示**有概率返回空 content** → 客户端必须处理（重试 / 补 prompt）

Chat Completions **不支持** `response_format: {"type":"json_schema"}`。

---

## 5. Tool Calls

- `tools` 只支持 `function` 类型
- `tool_choice`：`none` / `auto` / `required` / 指定函数
- ⚠️ **思考模式下传 `required` 或指定具名函数会 400**，需先关思考
- Chat Completions **不支持在对话中间插入 tool 消息**（Responses / Anthropic 格式支持）
- 模型给的 `arguments` 不保证合法 JSON，必须自己校验
- `strict` 严格模式是 Beta：需 `base_url=/beta`，每个 function 加 `strict:true`；
  不支持 `minLength/maxLength/minItems/maxItems`，object 所有属性必须 required 且 `additionalProperties:false`

---

## 6. 价格（人民币 / 百万 tokens）

| | flash 空闲 | flash 高峰 | v4-pro 空闲 | v4-pro 高峰 |
|---|---|---|---|---|
| 输入·缓存命中 | 0.02 元 | 0.04 元 | 0.15 元 | 0.30 元 |
| 输入·缓存未命中 | 1 元 | 2 元 | 4.5 元 | 9.0 元 |
| 输出 | 4 元 | 8 元 | 13.5 元 | 27.0 元 |

- **错峰折扣**：空闲 = 高峰的一半
- 高峰时段：**北京时间 周一至周五（不含法定节假日）9:00–12:00、14:00–18:00**
- 其余时间（含周末、法定节假日全天）都是空闲时段——**晚上和周末都便宜**
- 另有 Search / Fetch API：5 元 / 1000 次成功请求

---

## 7. 限速与流式

- 官方**只公布并发上限**：flash 2500、v4-pro 500；超出返回 **429**（未公布 RPM/TPM）
- 流式：`stream:true`，SSE，`data: [DONE]` 结束；`stream_options.include_usage` 拿用量
- 10 分钟未开始推理，服务端会断开连接
- Responses API 的流式以 `response.completed` 结束，**没有 `data: [DONE]`**

---

## 8. 本项目推荐配置

| 场景 | 模型 | 端点 | 思考 | 温度 |
|---|---|---|---|---|
| 生成计划 | `deepseek-v4-pro` | Responses + `json_schema` | enabled/high | 无效 |
| 出题 | `deepseek-flash` | Chat + `json_object` | disabled | 0.9 |
| 评分 | `deepseek-flash` | Chat + `json_object` | enabled | 无效 |
| 评分（严格模式） | `deepseek-v4-pro` | Chat + `json_object` | enabled | 无效 |
| 补学建议 | `deepseek-flash` | Chat + `json_object` | disabled | 0.5 |

**省钱的唯一技巧：把稳定内容放 prompt 前缀。** 教材原文、目标文档放前面，变量放后面，
命中 KVCache 后输入只要 0.02 元/百万 tokens。
