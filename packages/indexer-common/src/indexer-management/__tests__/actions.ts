/* eslint-disable @typescript-eslint/no-explicit-any */

import { Sequelize } from 'sequelize'
import gql from 'graphql-tag'
import { ethers } from 'ethers'
import {
  connectDatabase,
  connectContracts,
  createLogger,
  Logger,
  NetworkContracts,
  parseGRT,
} from '@graphprotocol/common-ts'

import {
  createIndexerManagementClient,
  IndexerManagementClient,
  IndexerManagementDefaults,
} from '../client'
import { Action, defineIndexerManagementModels, IndexerManagementModels } from '../models'
import {
  ActionInput,
  ActionStatus,
  ActionType,
  IndexingStatusResolver,
  NetworkSubgraph,
} from '@graphprotocol/indexer-common'
import { CombinedError } from '@urql/core'
import { GraphQLError } from 'graphql'

// Make global Jest variable available
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const __DATABASE__: any

const QUEUE_ACTIONS_MUTATION = gql`
  mutation queueActions($actions: [ActionInput!]!) {
    queueActions(actions: $actions) {
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
`

const APPROVE_ACTIONS_MUTATION = gql`
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
`

const CANCEL_ACTIONS_MUTATION = gql`
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
`

const EXECUTE_ACTIONS_MUTATION = gql`
  mutation executeActions($actionIDs: [Int!]!) {
    executeActions(actionIDs: $actionIDs) {
      id
      type
      allocationID
      deploymentID
      amount
      poi
      force
      source
      reason
      transaction
      status
    }
  }
`

const ACTIONS_QUERY = gql`
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
`
async function actionInputToExpected(
  input: ActionInput,
  id: number,
): Promise<{ [key: string]: any }> {
  const expected: Record<string, any> = { ...input }
  expected.id = id

  for (const actionKey in Action.getAttributes()) {
    if (!actionKey.includes('At') && expected[actionKey] === undefined) {
      expected[actionKey] = null
    }
  }
  return expected
}

let sequelize: Sequelize
let models: IndexerManagementModels
let address: string
let contracts: NetworkContracts
let logger: Logger
let indexingStatusResolver: IndexingStatusResolver
let networkSubgraph: NetworkSubgraph
let client: IndexerManagementClient

const defaults: IndexerManagementDefaults = {
  globalIndexingRule: {
    allocationAmount: parseGRT('100'),
    parallelAllocations: 1,
    requireSupported: true,
  },
}

const queuedAllocateAction = {
  status: ActionStatus.QUEUED,
  type: ActionType.ALLOCATE,
  deploymentID: 'QmZSJPm74tvhgr8uzhqvyQm2J6YSbUEj4nF6j8WxxUQLsC',
  amount: '10000',
  force: false,
  source: 'indexerAgent',
  reason: 'indexingRule',
  priority: 0,
} as ActionInput

const queuedUnallocateAction = {
  status: ActionStatus.QUEUED,
  type: ActionType.UNALLOCATE,
  allocationID: '0x8f63930129e585c69482b56390a09b6b176f4a4c',
  deploymentID: undefined,
  amount: undefined,
  poi: undefined,
  force: false,
  source: 'indexerAgent',
  reason: 'indexingRule',
  priority: 0,
} as ActionInput

const queuedReallocateAction = {
  status: ActionStatus.QUEUED,
  type: ActionType.REALLOCATE,
  allocationID: '0x8f63930129e585c69482b56390a09b6b176f4a4c',
  deploymentID: undefined,
  poi: undefined,
  amount: '27000',
  force: false,
  source: 'indexerAgent',
  reason: 'indexingRule',
  priority: 0,
} as ActionInput

const queuedCollectAction = {
  status: ActionStatus.QUEUED,
  type: ActionType.COLLECT,
  allocationID: '0x8f63930129e585c69482b56390a09b6b176f4a4c',
  deploymentID: undefined,
  poi: undefined,
  force: false,
  source: 'indexerAgent',
  reason: 'indexingRule',
  priority: 0,
} as ActionInput

describe('Actions', () => {
  beforeEach(async () => {
    // Spin up db
    sequelize = await connectDatabase(__DATABASE__)
    models = defineIndexerManagementModels(sequelize)
    address = '0xtest'
    contracts = await connectContracts(ethers.getDefaultProvider('rinkeby'), 4)
    await sequelize.sync({ force: true })
    logger = createLogger({ name: 'Indexer API Client', level: 'trace' })
    const statusEndpoint = 'http://localhost:8030/graphql'
    indexingStatusResolver = new IndexingStatusResolver({
      logger: logger,
      statusEndpoint,
    })
    networkSubgraph = await NetworkSubgraph.create({
      logger,
      endpoint: 'https://gateway.testnet.thegraph.com/network',
      deployment: undefined,
    })
    const indexNodeIDs = ['node_1']
    client = await createIndexerManagementClient({
      models,
      address,
      contracts,
      indexingStatusResolver,
      indexNodeIDs,
      deploymentManagementEndpoint: statusEndpoint,
      networkSubgraph,
      logger,
      defaults,
      features: {
        injectDai: true,
      },
    })
  })

  // afterEach(async () => {
  //   await sequelize.drop({})
  // })

  // TESTS
  // SUCCESSFULLY
  // queue and retrieve action
  // queue multiple and retrieve action of certain types
  // cancel all items in queue
  // approve subset of actions in queue

  // update single action
  // update multiple actions

  // FAIL TRYING TO
  // Empty action input is rejected

  // unsupported actionType is rejected from queueAction
  // unsupported actionType is rejected from updateAction
  // nonexistent actin id request is rejected (cance, update, approve)
  // set of actions some of which don't exist, entire request rejected (approve, cancel, update)

  test('Queue and retrieve action', async () => {
    const inputAction = queuedAllocateAction
    const expected = await actionInputToExpected(inputAction, 1)

    await expect(
      client.mutation(QUEUE_ACTIONS_MUTATION, { actions: [inputAction] }).toPromise(),
    ).resolves.toHaveProperty('data.queueActions', [expected])

    await expect(
      client
        .query(ACTIONS_QUERY, {
          filter: { status: ActionStatus.QUEUED, source: 'indexerAgent' },
        })
        .toPromise(),
    ).resolves.toHaveProperty('data.actions', [expected])
  })

  test('Queue many actions and retrieve all of a certain status', async () => {
    const inputActions = [
      queuedAllocateAction,
      queuedUnallocateAction,
      queuedReallocateAction,
      queuedCollectAction,
    ]
    const expecteds = await Promise.all(
      inputActions.map(async (action, key) => {
        return await actionInputToExpected(action, key + 1)
      }),
    )

    await expect(
      client.mutation(QUEUE_ACTIONS_MUTATION, { actions: inputActions }).toPromise(),
    ).resolves.toHaveProperty('data.queueActions', expecteds)

    await expect(
      client
        .query(ACTIONS_QUERY, {
          filter: {
            status: ActionStatus.QUEUED,
            type: ActionType.ALLOCATE,
            source: 'indexerAgent',
          },
        })
        .toPromise(),
    ).resolves.toHaveProperty('data.actions', [
      expecteds.find((action) => action.status === ActionStatus.QUEUED),
    ])
  })

  test('Cancel all actions in queue', async () => {
    const inputActions = [
      queuedAllocateAction,
      queuedUnallocateAction,
      queuedReallocateAction,
      queuedCollectAction,
    ]
    const expecteds = await Promise.all(
      inputActions.map(async (action, key) => {
        return await actionInputToExpected(action, key + 1)
      }),
    )

    await expect(
      client.mutation(QUEUE_ACTIONS_MUTATION, { actions: inputActions }).toPromise(),
    ).resolves.toHaveProperty('data.queueActions', expecteds)

    // Cancel all actions
    const toCancel = expecteds.map((action) => action.id)

    const expectedCancels = expecteds.map((action) => {
      action.status = ActionStatus.CANCELED
      return action
    })

    await expect(
      client.mutation(CANCEL_ACTIONS_MUTATION, { actionIDs: toCancel }).toPromise(),
    ).resolves.toHaveProperty('data.cancelActions', expectedCancels)

    await expect(
      client
        .query(ACTIONS_QUERY, {
          filter: {
            status: ActionStatus.CANCELED,
            source: 'indexerAgent',
          },
        })
        .toPromise(),
    ).resolves.toHaveProperty('data.actions', expectedCancels)
  })

  test('Approve action in queue', async () => {
    const inputActions = [
      queuedAllocateAction,
      queuedUnallocateAction,
      queuedReallocateAction,
      queuedCollectAction,
    ]
    const expecteds = await Promise.all(
      inputActions.map(async (action, key) => {
        //console.log(action, key)
        return await actionInputToExpected(action, key + 1)
      }),
    )

    await expect(
      client.mutation(QUEUE_ACTIONS_MUTATION, { actions: inputActions }).toPromise(),
    ).resolves.toHaveProperty('data.queueActions', expecteds)

    const reallocateActions = await client
      .query(ACTIONS_QUERY, { filter: { type: ActionType.REALLOCATE } })
      .toPromise()
    const reallocateActionIDs = reallocateActions.data.actions.map(
      (action: any) => action.id,
    )

    const expectedReallocateAction = expecteds.find(
      (action) => action.type === ActionType.REALLOCATE,
    )
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    expectedReallocateAction!['status'] = ActionStatus.APPROVED

    await expect(
      client
        .mutation(APPROVE_ACTIONS_MUTATION, { actionIDs: reallocateActionIDs })
        .toPromise(),
    ).resolves.toHaveProperty('data.approveActions', [expectedReallocateAction])

    await expect(
      client
        .query(ACTIONS_QUERY, {
          filter: {
            status: ActionStatus.APPROVED,
            source: 'indexerAgent',
          },
        })
        .toPromise(),
    ).resolves.toHaveProperty('data.actions', [expectedReallocateAction])
  })

  test('Empty action input is rejected', async () => {
    await expect(
      client.mutation(QUEUE_ACTIONS_MUTATION, { actions: [{}] }).toPromise(),
    ).resolves.toHaveProperty(
      'error',
      new CombinedError({
        graphQLErrors: [
          new GraphQLError(
            'Variable "$actions" got invalid value {} at "actions[0]"; Field "status" of required type "ActionStatus!" was not provided.',
          ),
          new GraphQLError(
            'Variable "$actions" got invalid value {} at "actions[0]"; Field "type" of required type "ActionType!" was not provided.',
          ),
          new GraphQLError(
            'Variable "$actions" got invalid value {} at "actions[0]"; Field "source" of required type "String!" was not provided.',
          ),
          new GraphQLError(
            'Variable "$actions" got invalid value {} at "actions[0]"; Field "reason" of required type "String!" was not provided.',
          ),
        ],
      }),
    )
  })
})
