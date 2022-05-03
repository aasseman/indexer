import {
  ActionFilter,
  ActionInput,
  ActionResult,
  ActionStatus,
  ActionType,
  IndexerManagementClient,
} from '@graphprotocol/indexer-common'
import { validateRequiredParams } from './command-helpers'
import gql from 'graphql-tag'

export interface GenericActionInputParams {
  target: string
  param1: string | undefined
  param2: string | undefined
  param3: string | undefined
}

// Make separate functions for each action type parsing from generic?
export async function buildActionInput(
  type: ActionType,
  actionParams: GenericActionInputParams,
  source: string,
  reason: string,
  status: ActionStatus,
  priority: number,
): Promise<ActionInput> {
  await validateActionInput(type, actionParams)
  switch (type) {
    case ActionType.ALLOCATE:
      return {
        deploymentID: actionParams.target,
        amount: actionParams.param1?.toString(),
        type,
        source,
        reason,
        status,
        priority,
      }
    case ActionType.UNALLOCATE:
      return {
        allocationID: actionParams.target,
        poi: actionParams.param1,
        force: actionParams.param2 === 'true',
        type,
        source,
        reason,
        status,
        priority,
      }
    case ActionType.REALLOCATE:
      return {
        allocationID: actionParams.target,
        amount: actionParams.param1?.toString(),
        poi: actionParams.param2,
        force: actionParams.param3 === 'true',
        type,
        source,
        reason,
        status,
        priority,
      }
    case ActionType.COLLECT:
      return {
        allocationID: actionParams.target,
        type,
        source,
        reason,
        status,
        priority,
      }
  }
}

export async function validateActionInput(
  type: ActionType,
  actionParams: GenericActionInputParams,
): Promise<void> {
  let requiredFields: string[] = []
  if (type === ActionType.ALLOCATE) {
    requiredFields = requiredFields.concat(['target', 'param1'])
  } else if (type === ActionType.UNALLOCATE) {
    requiredFields = requiredFields.concat(['target'])
  } else if (type === ActionType.REALLOCATE) {
    requiredFields = requiredFields.concat(['target', 'param1'])
  } else if (type === ActionType.COLLECT) {
    requiredFields = requiredFields.concat(['target'])
  }
  return await validateRequiredParams(
    { ...actionParams } as Record<string, unknown>,
    requiredFields,
  )
}

export async function queueActions(
  client: IndexerManagementClient,
  actions: ActionInput[],
): Promise<ActionResult[]> {
  const result = await client
    .mutation(
      gql`
        mutation queueActions($actions: [ActionInput!]!) {
          queueActions(actions: $actions) {
            id
            type
            deploymentID
            allocationID
            amount
            poi
            force
            source
            reason
            priority
            status
          }
        }
      `,
      { actions },
    )
    .toPromise()

  if (result.error) {
    throw result.error
  }

  return result.data.queueActions
}

export async function approveActions(
  client: IndexerManagementClient,
  actionIDs: number[],
): Promise<ActionResult[]> {
  const result = await client
    .mutation(
      gql`
        mutation approveActions($actionIDs: [Int!]!) {
          approveActions(actionIDs: $actionIDs) {
            id
            type
            allocationID
            deploymentID
            amount
            poi
            force
            source
            reason
            priority
            transaction
            status
          }
        }
      `,
      { actionIDs },
    )
    .toPromise()

  if (result.error) {
    throw result.error
  }

  return result.data.approveActions
}

export async function cancelActions(
  client: IndexerManagementClient,
  actionIDs: number[],
): Promise<ActionResult[]> {
  const result = await client
    .mutation(
      gql`
        mutation cancelActions($actionIDs: [Int!]!) {
          cancelActions(actionIDs: $actionIDs) {
            id
            type
            allocationID
            deploymentID
            amount
            poi
            force
            source
            reason
            priority
            transaction
            status
          }
        }
      `,
      { actionIDs },
    )
    .toPromise()

  if (result.error) {
    throw result.error
  }

  return result.data.cancelActions
}

export async function fetchAction(
  client: IndexerManagementClient,
  actionID: number,
): Promise<ActionResult> {
  const result = await client
    .query(
      gql`
        query action($actionID: Int!) {
          action(actionID: $actionID) {
            id
            type
            allocationID
            deploymentID
            amount
            poi
            force
            source
            reason
            priority
            transaction
            status
          }
        }
      `,
      { actionID },
    )
    .toPromise()

  if (result.error) {
    throw result.error
  }

  return result.data.action
}

export async function fetchActions(
  client: IndexerManagementClient,
  actionFilter: ActionFilter,
): Promise<ActionResult[]> {
  const result = await client
    .query(
      gql`
        query actions($filter: ActionFilter!) {
          actions(filter: $filter) {
            id
            type
            allocationID
            deploymentID
            amount
            poi
            force
            source
            reason
            priority
            transaction
            status
          }
        }
      `,
      { filter: actionFilter },
    )
    .toPromise()

  if (result.error) {
    throw result.error
  }

  return result.data.actions
}
