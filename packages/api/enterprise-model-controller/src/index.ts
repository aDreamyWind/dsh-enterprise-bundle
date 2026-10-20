/** Authenticated enterprise model-directory policy beside the upstream Session API. */
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Enterprise-authorized model directory without replacing the Session controller. */
    enterpriseModelController: EnterpriseModelController
  }
}

/** Own the enterprise model directory independently of ordinary Session operations. */
export class EnterpriseModelController extends TypertRemoteService {
  static inject = ['sessionController', 'agentDefaultModel']

  /** @param ctx - Host carrying the upstream Session controller and enterprise model-default provider. */
  constructor(ctx: Context) { super(ctx, 'enterpriseModelController', { namespace: 'enterpriseModels' }) }

  /**
   * Describe the authorized catalog and sample its default after provider discovery completes.
   * @returns provider groups and failures with the availability-adjusted deployment default.
   */
  @Remote
  async modelCatalog(): Promise<ModelCatalog> {
    const catalog = await this.ctx.sessionController.modelCatalog()
    return { ...catalog, default: { ...this.ctx.agentDefaultModel.currentSelection() } }
  }
}

export default EnterpriseModelController
