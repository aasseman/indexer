import { ActionManager, ActionStatus } from '@graphprotocol/indexer-common'
import { Logger, join, timer } from '@graphprotocol/common-ts'
import { AllocationManager } from './allocations'

export class IndexerWorker {
  constructor(
    private actionManager: ActionManager,
    private allocationManager: AllocationManager,
    private logger: Logger,
  ) {}

  async start(logger: Logger): Promise<IndexerWorker> {
    // Setup worker
    logger.info('Starting up indexer worker', {
      rasionDetre: 'execute approved items in the actions queue',
      pollingInterval: '60 sec',
    })

    const approvedActions = timer(60_000).tryMap(
      () => this.actionManager.fetchActions({ status: ActionStatus.APPROVED }),
      {
        onError: (err) =>
          this.logger.warn('Failed to fetch approved actions from queue', { err }),
      },
    )

    join({ approvedActions }).pipe(async ({ approvedActions }) => {

      // TODO: Wait until enough actions accumulate and execute as a batch (using configs to control size)
      await this.actionManager.executeActions(
        approvedActions.map((action) => action.id),
        false,
      )
    })

    return this
  }
}
