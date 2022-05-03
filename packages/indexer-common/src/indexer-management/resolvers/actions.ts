/* eslint-disable @typescript-eslint/ban-types */

import { IndexerManagementResolverContext } from '../client'
import {
  Action,
  ActionFilter,
  ActionInput,
  ActionResult,
  ActionStatus,
} from '@graphprotocol/indexer-common'

export default {
  action: async (
    { actionID }: { actionID: string },
    { models }: IndexerManagementResolverContext,
  ): Promise<ActionResult | null> => {
    return await models.Action.findOne({
      where: { id: actionID },
    })
  },

  actions: async (
    { filter }: { filter: ActionFilter },
    { logger, actionManager }: IndexerManagementResolverContext,
  ): Promise<object[]> => {
    logger.info('Received query', {
      filter,
    })
    return await actionManager.fetchActions(filter)
  },

  queueActions: async (
    { actions }: { actions: ActionInput[] },
    { models }: IndexerManagementResolverContext,
  ): Promise<ActionResult[]> => {
    return await models.Action.bulkCreate(actions, {
      returning: true,
      // include: [{ model: ActionParams }],
    })
  },

  cancelActions: async (
    { actionIDs }: { actionIDs: number[] },
    { models }: IndexerManagementResolverContext,
  ): Promise<ActionResult[]> => {
    const [, canceledActions] = await models.Action.update(
      { status: ActionStatus.CANCELED },
      { where: { id: actionIDs }, returning: true },
    )

    if (canceledActions.length === 0) {
      throw Error(`'0' action items updated in the queue to status = CANCELED`)
    }

    return canceledActions
  },

  updateAction: async (
    { action }: { action: Action },
    { models }: IndexerManagementResolverContext,
  ): Promise<ActionResult> => {
    const [, updatedActions] = await models.Action.update(action, {
      where: { id: action.id },
      returning: true,
    })

    if (updatedActions.length === 0) {
      throw Error(`'0' action items updated in the queue`)
    }
    if (updatedActions.length > 1) {
      throw Error(
        `${updatedActions.length} action items updated in the queue. Should be '1'`,
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return updatedActions[0]
  },

  approveActions: async (
    { actionIDs }: { actionIDs: number[] },
    { models }: IndexerManagementResolverContext,
  ): Promise<ActionResult[]> => {
    const [, updatedActions] = await models.Action.update(
      { status: ActionStatus.APPROVED },
      { where: { id: actionIDs }, returning: true },
    )

    if (updatedActions.length === 0) {
      throw Error(`'0' action items updated in the queue to status = APPROVED`)
    }

    return updatedActions
  },

  executeActions: async (
    { actionIDs, force }: { actionIDs: number[]; force: boolean },
    { actionManager }: IndexerManagementResolverContext,
  ): Promise<ActionResult[]> => {
    return await actionManager.executeActions(actionIDs, force)
  },
}
