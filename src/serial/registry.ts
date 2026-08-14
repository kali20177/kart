// 传输注册表：镜像 themes/decoders 模式——内置传输在 index.ts 顶层注册，后续新传输（udp 等）可追加。
import type { DriverType, IoTransport } from '@/types'

export interface TransportDef {
  type: DriverType
  create: () => IoTransport
}

const registry = new Map<DriverType, TransportDef>()

export function registerTransport(def: TransportDef): void {
  registry.set(def.type, def)
}

export function getTransportDef(type: DriverType): TransportDef | undefined {
  return registry.get(type)
}

export function listTransports(): TransportDef[] {
  return Array.from(registry.values())
}
