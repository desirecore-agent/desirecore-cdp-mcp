import { CdpBridge } from './cdp.js'
import type { BridgeConfig } from './config.js'
import { discoverInstances, type InstanceInfo, type Inventory } from './instance.js'

export interface InstanceList {
  instances: InstanceInfo[]
  warnings: string[]
}

/** 进程独立、连接按代际隔离；一台实例故障不终止 MCP 或其他实例。 */
export class InstanceManager {
  private entries = new Map<string, { bridge: CdpBridge; busy: boolean }>()
  private busy = new Set<string>()
  private blocked = new Map<string, string>()
  private closed = false

  constructor(
    private readonly config: BridgeConfig,
    private readonly discover: (signal: AbortSignal) => Promise<Inventory> = (signal) =>
      discoverInstances(config, signal)
  ) {}

  private async refresh(signal: AbortSignal): Promise<Inventory> {
    if (this.closed) throw new Error('MCP 实例管理器已关闭')
    const inventory = await this.discover(signal)
    if (this.closed) throw new Error('MCP 实例管理器已关闭')
    const live = new Set(inventory.instances.map(({ info }) => info.instanceId))
    for (const [id, entry] of this.entries) {
      // 空闲时也可能收到断线；在删除连接前保留代际故障，不只依赖调用 catch。
      if (entry.bridge.failureMessage) {
        if (!this.blocked.has(id) && this.blocked.size >= 256)
          throw new Error('故障代际记录已达上限，请核实实例后重启 MCP')
        this.blocked.set(id, entry.bridge.failureMessage)
      }
      if (!live.has(id) && !entry.busy) {
        entry.bridge.close()
        this.entries.delete(id)
      }
    }
    return inventory
  }

  async list(signal: AbortSignal): Promise<InstanceList> {
    const inventory = await this.refresh(signal)
    return {
      warnings: inventory.warnings,
      instances: inventory.instances.map(({ info }) => {
        const failure = info.instanceId
          ? (this.blocked.get(info.instanceId) ?? this.entries.get(info.instanceId)?.bridge.failureMessage)
          : undefined
        return failure ? { ...info, available: false, reason: failure } : info
      }),
    }
  }

  async withInstance<TResult>(
    instanceId: string,
    signal: AbortSignal,
    fn: (bridge: CdpBridge) => Promise<TResult>
  ): Promise<TResult> {
    if (this.busy.has(instanceId)) throw new Error('该实例已有工具调用正在执行，本次未执行；请先观察它的结果')
    this.busy.add(instanceId)
    let entry = this.entries.get(instanceId)
    if (entry) entry.busy = true
    try {
      const inventory = await this.refresh(signal)
      const blocked = this.blocked.get(instanceId)
      if (blocked) throw new Error(blocked)
      if (this.blocked.size >= 256) throw new Error('故障代际记录已达上限，请核实实例后重启 MCP')
      const selected = inventory.instances.find(({ info }) => info.instanceId === instanceId)
      if (!selected?.info.available || !selected.binding) {
        throw new Error('实例不存在或代际已失效；请调用 desirecore_list_instances 重新选择 instanceId，不会自动切换')
      }
      signal.throwIfAborted()
      if (!entry) {
        const bridge = new CdpBridge(selected.binding, this.config.timeoutMs)
        entry = { bridge, busy: true }
        this.entries.set(instanceId, entry)
        try {
          await bridge.connect(signal)
        } catch (error) {
          bridge.close()
          throw error
        }
      }
      await entry.bridge.assertCurrent(signal)
      return await fn(entry.bridge)
    } catch (error) {
      // 保留失败代际的拒绝记录；名录暂时缺失后恢复也不能悄悄重建连接。
      if (entry?.bridge.failureMessage) this.blocked.set(instanceId, entry.bridge.failureMessage)
      throw error
    } finally {
      if (entry) entry.busy = false
      this.busy.delete(instanceId)
    }
  }

  close(): void {
    this.closed = true
    for (const entry of this.entries.values()) entry.bridge.close()
    this.entries.clear()
  }
}
