import { describe, expect, it } from 'vitest'
import { selectByStrategy, priceOf } from '../src/strategy.ts'
import type { StrategyCandidate, StrategySettings } from '../src/strategy.ts'

// 探针：iwhalecloud 全目录模型（从实际 settings.yaml 读出）+ cost 模式，
// 验证「纯 provider 级 fallback 会不会挑出云端付费模型而不是本地模型」。
// 这是 A 方案（fallback 链不写 model、让插件轮询目录）的真实行为验证，不是单元测试。

const iwhalecloudModels = [
  'g-deepseek-v4-flash', 'g-deepseek-v4-pro', 'g-qwen3.8-max', 'g-glm-5', 'g-glm-5.1',
  'g-glm-5.2', 'g-kimi-k3', 'g-minimax-m3', 'g-gpt-5.5', 'g-gpt-5.6-luna',
  'g-gpt-5.6-sol', 'g-gpt-5.6-terra', 'b-claude-4.8-opus', 'b-claude-5-fable',
  'b-claude-5-sonnet', 'claude-4.7-opus', 'local-deepseek-v4-flash',
  'local-qwen3.5-122b-a10b', 'local-qwen3.8-27b', 'glm-4.6v', 'glm-5v-turbo',
  'qwen3-vl-plus', 'doubao-seed-1.6-vision',
]

const prices = {
  iwhalecloud: { input: 1, output: 1.5 },
  'zai-coding-cn': { input: 3, output: 3 },
}

const baseSettings: StrategySettings = {
  mode: 'cost',
  marginTokens: 8192,
  estimatedOutputTokens: 1024,
  futureSteps: 1,
  sessionFailurePenalty: 2,
  cliffPenalty: 1.5,
  axes: ['reasoning', 'context', 'output'],
  significantRatio: 1.5,
}

const chainIndexByModel = (model: string): number =>
  // 模拟 config 里 iwhalecloud 是第一个 chain 条目：所有 iwhalecloud 模型 chainIndex=0
  0

function makeCandidates(): StrategyCandidate[] {
  return iwhalecloudModels.map(model => {
    const price = priceOf(prices, 'iwhalecloud', model)
    return {
      provider: 'iwhalecloud',
      model,
      chainIndex: chainIndexByModel(model),
      modalities: ['text'],
      ...price?.input === undefined ? {} : { inputPrice: price.input },
      ...price?.output === undefined ? {} : { outputPrice: price.output },
      // iwhalecloud 目录不声明 contextWindow → allowUnknownCapacity 模式下窗口未知
    }
  })
}

describe('provider-level fallback probe (iwhalecloud full catalog)', () => {
  it('cost 模式在 iwhalecloud 全目录里选出哪个模型', () => {
    const candidates = makeCandidates()
    const sel = selectByStrategy(candidates, baseSettings, 1000, ['text'], true)
    console.log('cost winner:', JSON.stringify(sel))
    expect(sel).toBeDefined()
  })

  it('展示 iwhalecloud 全目录 cost 评分排序（本地 vs 云端）', () => {
    const candidates = makeCandidates()
    const floor = 1000 + baseSettings.marginTokens
    const scored = candidates
      .map(c => ({ model: c.model, price: priceOf(prices, 'iwhalecloud', c.model) }))
    // costScore 对所有 iwhalecloud 模型同样：同价 → 破平靠 chainIndex 再 model.localeCompare
    const sorted = [...scored].sort((a, b) => a.model.localeCompare(b.model))
    console.log('alphabetical order (tie-break):', sorted.map(x => x.model).join(', '))
    console.log('first (winner by localeCompare):', sorted[0]?.model)
    console.log('local-* present:', sorted.filter(x => x.model.startsWith('local-')).map(x => x.model))
    expect(true).toBe(true)
  })
})
