/** Enterprise availability policy over the upstream default-model service. */
import { Context, type Volatile } from '@deepseek-ai/cordis'
import { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Enterprise-only publication of authenticated model availability. */
    enterpriseModelDefaults: EnterpriseDefaultModelConfig
  }
}

/** Deployment default fields validated by the upstream default-model schema. */
export interface Config {
  /** Registered enterprise provider route. */
  provider: Volatile<string>
  /** Initial model candidate, replaced in memory when the catalog excludes it. */
  model: Volatile<string>
  /** Optional effort for the configured candidate, never inherited by a fallback. */
  reasoningEffort: Volatile<string | undefined>
}

/** Replace the upstream default-model provider without changing its configuration or persistence. */
export class EnterpriseDefaultModelConfig extends AgentDefaultModelConfig {
  private readonly available = new Map<string, readonly string[]>()

  /**
   * @param ctx - owning Host context.
   * @param config - upstream default provider, model, and optional reasoning effort.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    ctx.effect(() => ctx.provide('enterpriseModelDefaults', this), 'enterprise default-model availability')
  }

  /**
   * Read the deployment default, using the first authorized model when its candidate is unavailable.
   * @returns a detached selection; a fallback never inherits the candidate's reasoning effort.
   */
  override currentSelection(): ModelSelection {
    const configured = super.currentSelection()
    const models = this.available.get(configured.provider)
    const first = models?.[0]
    if (first === undefined || models?.includes(configured.model) === true) return configured
    return { provider: configured.provider, model: first }
  }

  /**
   * Publish authenticated model ids without writing a user-specific fallback into deployment config.
   * @param provider - provider route owning this catalog.
   * @param models - authorized ids in fallback order; an empty list retains the configured candidate.
   */
  setAvailableModels(provider: string, models: readonly string[]): void {
    this.available.set(provider, [...models])
  }

  /**
   * Remove an unloading provider's availability publication.
   * @param provider - provider route whose publication is removed.
   */
  clearAvailableModels(provider: string): void { this.available.delete(provider) }
}

export default EnterpriseDefaultModelConfig
