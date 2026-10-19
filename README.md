# dsh-die-adaptive-thinking

让 dsh 能正常调用 `die` 中转站（`https://cfapi.dieqiyun.top`，Anthropic Messages 协议）的 `claude-sonnet-5-5` 与 `claude-opus-5-5`。

## 解决的问题

`claude-sonnet-5-5` 与 `claude-opus-5-5` 不再接受预算式 extended thinking。dsh 选好推理档位后，pi-ai 会发出：

```json
{ "thinking": { "type": "enabled", "budget_tokens": 16384, "display": "summarized" } }
```

`die` 上游直接拒绝（两个模型的提示措辞略有不同）：

```
400 claude-sonnet-5-5 requires adaptive thinking or thinking.type=between_tools;
    omit thinking or use one of those modes
400 claude-opus-5-5 requires adaptive thinking; omit thinking or use thinking.type=adaptive and output_config.effort
```

请求在第一跳就失败，整个会话会反复重试同一条被拒的请求，模型完全不可用。

## 修复方式

不重写请求、不改会话日志。插件装饰 `@deepseek-ai/dsh-llm-pi-ai` 注册的 adapter，在 `modelOf()` 返回的模型描述符上打开 pi-ai 自己的兼容开关：

```js
compat: { forceAdaptiveThinking: true }
```

之后 `streamSimple` 会把推理档位映射成 Anthropic effort，发：

```json
{
  "thinking": { "type": "adaptive", "display": "summarized" },
  "output_config": { "effort": "high" }
}
```

这是 pi-ai 为「必须自适应思考」的模型准备的官方开关，不是私有补丁。

范围按 route / 模型 / 协议三重限定，只碰 `die` 上的 `claude-sonnet-5-5` 与 `claude-opus-5-5`（Anthropic Messages 协议），同一中转站上的旧 Claude 模型保持预算式思考不变。

## 安装

```yaml
# profile 的 package.json
"dependencies": {
  "dsh-die-adaptive-thinking": "file:D:/code/dsh插件/dsh-die-adaptive-thinking"
}
```

```json
// dsh.profile.bundles —— 放在 "@deepseek-ai/dsh-base" 之前
"dsh-die-adaptive-thinking"
```

插件自带 bundle patch（`cordis.patch.yml`），加进 bundles 即生效，无需再手写 profile 的 patch 行。

先注册后挂载也支持：插件会原地替换已注册的 adapter，并在日志里说明。不过按上面的顺序放置仍是推荐做法。

## 配置

默认值已适合 `die` 的 `claude-sonnet-5-5` 与 `claude-opus-5-5`，需要时可以按 id 覆盖：

```yaml
- id: die-adaptive-thinking
  config:
    enabled: true
    routes: ['die']                     # 生效的 provider route
    models: ['claude-sonnet-5-5', 'claude-opus-5-5']  # 空数组 = 该 route 上所有模型
    apis: ['anthropic-messages']        # 只处理 Anthropic Messages 模型
    log: true
```

例如同一个中转站又加了别的必须自适应思考的新模型：

```yaml
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5']
```

## 验证

```bash
node --test test/
```

- 单元测试覆盖配置解析、描述符修补、adapter 装饰（注册前 / 注册后两条路径）、dispose 还原。
- `test/wire.test.js` 用本地 HTTP server 捕获 pi-ai 真正发出的请求体：对照用例断言未修补时是 `thinking.type: "enabled"`，修补后是 `thinking.type: "adaptive"` + `output_config.effort`，并遍历 low/medium/high/xhigh/max。本机没装 pi-ai 时该用例自动 skip。

上游实测（2026-10）：
- `thinking.type: enabled` → HTTP 400（本文开头的错误），两个模型一致
- `thinking.type: adaptive` + effort（low/medium/high/xhigh/max）→ HTTP 200，两个模型一致
- adaptive 下 `max_tokens` 取 sonnet 的 256000 / opus 的 32768 均被接受

## 限制

- 只解决 `anthropic-messages` 协议的 thinking 形态；其他协议的模型原样放行。
- 不改写请求内容，不干预错误重试；上游若改变要求（例如只接受 `between_tools`），需要换一种开关，而不是本插件可以自动跟随的。
- 依赖 pi-ai 的 `forceAdaptiveThinking` 兼容字段（dsh 0.2.x 内置的 pi-ai 0.87 已有）。
