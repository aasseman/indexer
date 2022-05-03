import {
  Action,
  ActionFilter,
  ActionStatus,
  ActionType,
  IndexerManagementModels,
} from '@graphprotocol/indexer-common'
import { AllocationManager } from './allocations'
import { SubgraphDeploymentID } from '@graphprotocol/common-ts'
import { BigNumber } from 'ethers'
import { Transaction } from 'sequelize'

export class ActionManager {
  constructor(
    public allocationManager: AllocationManager,
    private models: IndexerManagementModels,
  ) {}

  async executeActions(actionIDs: number[], force: boolean): Promise<Action[]> {
    const updatedActions: Action[] = []

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this.models.Action.sequelize!.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
      async (transaction) => {
        if (!force) {
          // Execute already approved actions first
          const approvedActions = await this.models.Action.findAll({
            where: { status: ActionStatus.APPROVED },
            transaction,
          })
          for (const action of approvedActions) {
            try {
              await this.takeAction(action)
              const [, updatedAction] = await this.models.Action.update(
                { status: ActionStatus.SUCCESS },
                {
                  where: { id: action.id },
                  returning: true,
                  transaction,
                },
              )
              updatedActions.concat(updatedAction)
            } catch (error) {
              // TODO: Update failureReason too
              const [, updatedAction] = await this.models.Action.update(
                { status: ActionStatus.FAILED },
                {
                  where: { id: action.id },
                  returning: true,
                  transaction,
                },
              )
              updatedActions.concat(updatedAction)
            }
          }
        }

        // Now execute actions specified in input (if they are already queued)
        const queuedActionsSpecified = (
          await this.models.Action.findAll({
            where: { status: ActionStatus.QUEUED },
            transaction,
          })
        ).filter((action) => actionIDs.includes(action.id))

        for (const action of queuedActionsSpecified) {
          try {
            await this.takeAction(action)
            const [, updatedAction] = await this.models.Action.update(
              { status: ActionStatus.SUCCESS },
              {
                where: { id: action.id },
                returning: true,
                transaction,
              },
            )
            updatedActions.concat(updatedAction)
          } catch (error) {
            // TODO: Add failure reason to Action model and insert here
            const [, updatedAction] = await this.models.Action.update(
              { status: ActionStatus.FAILED },
              {
                where: { id: action.id },
                returning: true,
                transaction,
              },
            )
            updatedActions.concat(updatedAction)
          }
        }
      },
    )

    return updatedActions
  }

  async fetchActions(filter: ActionFilter): Promise<Action[]> {
    const filterObject = JSON.parse(JSON.stringify(filter))
    return await this.models.Action.findAll({
      where: filterObject,
    })
  }

  // TODO: return transaction id, support batch action execution using multicall
  //
  async takeAction(action: Action): Promise<any> {
    if (action.type === ActionType.ALLOCATE) {
      return await this.allocationManager.allocate(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        new SubgraphDeploymentID(action.deploymentID!),
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        BigNumber.from(action.amount!),
        undefined,
      )
    } else if (action.type === ActionType.UNALLOCATE) {
      return await this.allocationManager.unallocate(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        action.allocationID!,
        action.poi === null ? undefined : action.poi,
        action.force === null ? false : action.force,
      )
    } else if (action.type === ActionType.REALLOCATE) {
      return await this.allocationManager.reallocate(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        action.allocationID!,
        action.poi === null ? undefined : action.poi,
        BigNumber.from(action.amount),
        action.force === null ? false : action.force,
      )
    } else if (action.type === ActionType.COLLECT) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return await this.allocationManager.collect(action.allocationID!)
    }
  }
}
