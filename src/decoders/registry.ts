// 解码器注册表：静态 Map + register/get/list（镜像 themes/registry.ts 模式）。
// 内置集在 index.ts 模块顶层 register，导入即注册。

import type { DecoderDefinition } from './types'

const registry = new Map<string, DecoderDefinition>()

export function register<O>(decoder: DecoderDefinition<O>): void {
  // 异构 options 类型在注册边界统一收窄为 unknown（消费方把 options 当不透明 JSON）
  registry.set(decoder.id, decoder as DecoderDefinition)
}

export function getDecoder(id: string): DecoderDefinition | undefined {
  return registry.get(id)
}

export function listDecoders(): DecoderDefinition[] {
  return Array.from(registry.values())
}
