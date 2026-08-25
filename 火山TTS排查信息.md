# 双向流式 TTS 音色波动 — 排查信息

## 1. 基本参数

| 项 | 值 |
|---|---|
| 接口 | wss://openspeech.bytedance.com/api/v3/tts/bidirection |
| X-Api-Resource-Id | seed-tts-2.0（**官方精品音色，不是声音复刻**） |
| speaker | zh_male_liufei_uranus_bigtts（刘飞 2.0）|
| req_params.model | 未指定（用服务端默认）|
| 鉴权 | 旧版控制台，X-Api-App-Id + X-Api-App-Key + X-Api-Access-Key |
| AppID | 2017995201 |

同一现象在 zh_male_yuanboxiaoshu_uranus_bigtts（渊博小叔 2.0）上同样出现，
不是单个音色的问题。

## 2. X-Tt-Logid

握手响应头抓到的 logid（同一条连接、连续 3 个 session）：

- 20260825153139D1501148A5DBC007DB4C

同一条连接内的 session_id：

- 第 1 个 session: 24bfac9c-c463-4e5f-9fd2-89e3b919b7c1
- 第 2 个 session: 52cefc9e-8f4b-4cd8-9a7f-abf2489ab8a1
- 第 3 个 session: 2ca9176f-6155-4bed-bc88-8058c103c2bb

## 3. 我们实际发出的 StartSession payload

```json
{
  "event": 100,
  "req_params": {
    "speaker": "zh_male_liufei_uranus_bigtts",
    "section_id": "a6685cb2-643e-4964-be1b-ddbfa08f178b",
    "audio_params": {
      "format": "pcm",
      "sample_rate": 24000,
      "speech_rate": -5,
      "enable_subtitle": true
    },
    "additions": "{\"max_length_to_filter_parenthesis\":100,\"section_id\":\"a6685cb2-643e-4964-be1b-ddbfa08f178b\",\"explicit_language\":\"zh-cn\"}"
  }
}
```

## 4. 关于"差异大"具体是什么（这一条有实测数据）

**不是音色本身变了，是韵律/情绪在飘。**

做法：同一句话念 6 遍，唯一变量是"这 6 遍在不在同一个 session 里"，
对音频做声学测量。

| 指标 | 同一 session 内 6 遍 | 6 个不同 session |
|---|---|---|
| 谱质心（音色亮暗的代理量） | 极差 33 Hz（均值 580） | 极差 27 Hz（均值 565） |
| 基频底部（音高身份） | 极差 4.8 Hz | 极差 10.0 Hz |
| 基频中位数（语调/情绪） | **111 → 140 Hz** | 94 → 127 Hz |

结论：
- **谱质心跨 session 和同 session 内一样稳**，所以音色（音质、共振峰）没有变，
  不是 speaker 传错或音色未训练完成那类问题。
- 变的是基频中位数，而且**同一个 session 内、同一句话念 6 遍也会从 111 跳到 140 Hz**。
  也就是说波动主要来自模型对每次合成的韵律/情绪重新规划，session 边界只是次要因素
  （基频底部 4.8 → 10.0 Hz）。

主观感受是"像换了个人"，但客观上音色是同一个，是语调起伏幅度太大造成的。

## 5. 我们已经做到的（对照贵方建议）

| 建议 | 我们的状态 |
|---|---|
| 使用同一次连接，多次 StartSession | ✅ 一通电话一条 WebSocket，中途不重连 |
| 传 section_id | ⚠️ 见下方问题 1 |
| 固定 audio_params | ✅ format/sample_rate/speech_rate 全程不变，未用 emotion/pitch |
| 固定 model 版本 | ❌ 未指定。我们用的是精品音色不是复刻，需要确认是否也该固定 |
| 显式固定语种 | ✅ 已加 explicit_language=zh-cn |
| 不在客户端切句 | ❌ 见下方问题 2 |
| cache_config | ❌ 未用 |

## 6. 补测结果：context_texts 的位置是关键（已自行定位）

贵方回复提到 `context_texts` 在 `req_params.additions` 里。我们之前**放在
`req_params` 顶层**，所以此前几轮"context_texts 无效"的测试结论全部作废——
参数根本没送达。

用「说慢一点」这种时长可验证的指令做判据（时长是硬指标，跟基频抖动无关），
两次独立测试方向一致：

| 指令位置 | 平均时长（基线 3.77 / 3.94s） |
|---|---|
| `req_params.context_texts`（顶层） | 3.82s / 3.88s ← 与基线无差别，**未生效** |
| `req_params.additions.context_texts` | 4.41s / 4.34s ← **+17% / +10%，生效** |

确认位置后，用「你可以一直用同一个语气说话吗？平稳一点，不要有情绪起伏。」
做正式测试（同句话念 8 遍，另跑一组同配置基线量噪声）：

| | 句间基频标准差 | 句间基频极差 |
|---|---|---|
| 基线 A1 | 8.5 Hz | 30.7 Hz |
| 基线 A2（重复，量噪声） | 9.4 Hz | 29.8 Hz |
| 加稳定指令 | **7.2 Hz** | **21.2 Hz** |

两组基线之间只差 0.9~1.0 Hz，说明测量噪声很小；加指令后标准差降 19%、
极差降 29%，降幅远超噪声。**结论：语音指令确实能收窄波动，但压不平。**

`section_id` 同理，我们原先也放在顶层，现已移到 additions。

### 一个文档层面的建议

《双向流式语音合成WebSocket》正文里，`section_id` 和 `context_texts` 都是作为
`req_params` 的直接子字段列出的（与 `speaker`、`audio_params` 同级），没有标明
要放进 `additions`。按文档正文实现会静默失效、不报错，排查成本很高。
建议在文档里明确这两个字段的层级。

## 7. 仍需贵方确认的问题

### 问题 1：section_id 到底放哪一层？

- 文档《双向流式语音合成WebSocket》正文里，section_id 是 **req_params 的直接字段**
- 贵方客服回复里写的是 **req_params.additions.section_id**

两处位置不一样。我们从外部无法验证哪个生效（放错的话会静默失效，不报错）。
目前**两处都放了**（见第 3 节 payload）。请帮忙用上面的 logid 在服务端确认
section_id 是否真的被识别、跨 session 的上下文是否关联上了。

### 问题 2：不做客户端切句，和 TTS 的最小合成长度冲突

贵方建议"直接把大模型流式输出的文本喂进去，不要额外切句"。但我们实测发现，
**送入不足 5 个字的片段时，TTS 在 finishSession 之前不会开始合成**：

| 送入内容（只发一次，不调 finishSession） | 首个音频包 |
|---|---|
| 「嗯。」（2 字） | 3.5 秒内没有音频 |
| 「嗯，好的。」（5 字） | 339 ms |
| 「嗯，我明白您的意思。」（10 字） | 318 ms |
| 13 字 | 253 ms |
| 「嗯，」+ 立刻 finishSession | 260 ms |

LLM 流式输出的头几个 token 往往就是「嗯，」这种两三个字。如果完全不切句、
逐 token 直接转发，第一个包同样是两三个字，按上表就会卡住。

想确认：
1. 这个"最小长度才开始合成"的行为是预期的吗？有没有参数可以调低阈值？
2. 在"不做客户端切句"的前提下，如何避免首包因为太短而卡住？
3. 逐 token 转发（每次 1~3 个字）和按句转发，对韵律规划的影响哪个更好？

## 8. 补充

- 语速固定 speech_rate = -5，全程不变
- 文本全部是中文，无中英混读、无方言
- 未使用 emotion / emotion_scale / post_process.pitch
- 未使用 context_texts（试过用它下"语气平稳"的指令，实测对波动没有可测量的改善）
