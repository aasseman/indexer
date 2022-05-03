import {
  formatGRT,
  Logger,
  NetworkContracts,
  SubgraphDeploymentID,
  toAddress,
} from '@graphprotocol/common-ts'
import {
  Allocation,
  allocationIdProof,
  AllocationStatus,
  CloseAllocationResult,
  CreateAllocationResult,
  indexerError,
  IndexerErrorCode,
  IndexerManagementModels,
  IndexingDecisionBasis,
  IndexingRuleAttributes,
  IndexingStatusResolver,
  Network,
  NetworkSubgraph,
  parseGraphQLAllocation,
  ReallocateAllocationResult,
  ReceiptCollector,
  SubgraphIdentifierType,
  TransactionManager,
  uniqueAllocationID,
} from '@graphprotocol/indexer-common'
import { BigNumber, utils } from 'ethers'
import { NetworkMonitor } from './monitor'
import { SubgraphManager } from './subgraphs'
import gql from 'graphql-tag'

export class AllocationManager {
  constructor(
    private contracts: NetworkContracts,
    private logger: Logger,
    private indexer: string,
    private indexingStatusResolver: IndexingStatusResolver,
    private models: IndexerManagementModels,
    private network: Network,
    private networkSubgraph: NetworkSubgraph,
    private subgraphManager: SubgraphManager,
    private transactionManager: TransactionManager,
    private receiptCollector: ReceiptCollector,
    private networkMonitor: NetworkMonitor,
  ) {}

  async allocate(
    deployment: SubgraphDeploymentID,
    amount: BigNumber,
    indexNode: string | undefined,
  ): Promise<CreateAllocationResult> {
    this.logger.info('Creating allocation', { deployment: deployment.ipfsHash, amount })

    const activeAllocations = await this.networkMonitor.allocations(
      AllocationStatus.Active,
    )
    const allocation = activeAllocations.find(
      (allocation) =>
        allocation.subgraphDeployment.id.toString() === deployment.toString(),
    )
    if (allocation) {
      this.logger.warn('Already allocated to deployment', {
        deployment: allocation.subgraphDeployment.id.ipfsHash,
        activeAllocation: allocation.id,
      })
      throw new Error(
        `Allocation failed. An active allocation already exists for deployment '${allocation.subgraphDeployment.id.ipfsHash}'.`,
      )
    }

    if (amount.lt('0')) {
      this.logger.warn('Cannot allocate a negative amount of GRT', {
        amount: amount.toString(),
      })
      throw new Error(
        `Invalid allocation amount provided (${amount.toString()}). Must use positive allocation amount.`,
      )
    }

    if (amount.eq('0')) {
      this.logger.warn('Cannot allocate zero GRT', {
        amount: amount.toString(),
      })
      throw new Error(
        `Invalid allocation amount provided (${amount.toString()}). Must use nonzero allocation amount.`,
      )
    }

    try {
      const currentEpoch = await this.contracts.epochManager.currentEpoch()

      // Identify how many GRT the indexer has staked
      const freeStake = await this.contracts.staking.getIndexerCapacity(this.indexer)

      // If there isn't enough left for allocating, abort
      if (freeStake.lt(amount)) {
        this.logger.error(
          `Allocation of ${formatGRT(
            amount,
          )} GRT cancelled: indexer only has a free stake amount of ${formatGRT(
            freeStake,
          )} GRT`,
        )
        throw indexerError(
          IndexerErrorCode.IE013,
          new Error(
            `Allocation of ${formatGRT(
              amount,
            )} GRT cancelled: indexer only has a free stake amount of ${formatGRT(
              freeStake,
            )} GRT`,
          ),
        )
      }

      // Ensure subgraph is deployed before allocating
      await this.subgraphManager.ensure(
        this.logger,
        this.models,
        `${deployment.ipfsHash.slice(0, 23)}/${deployment.ipfsHash.slice(23)}`,
        deployment,
        indexNode,
      )

      this.logger.debug('Obtain a unique Allocation ID')

      // Obtain a unique allocation ID
      const { allocationSigner, allocationId } = uniqueAllocationID(
        this.transactionManager.wallet.mnemonic.phrase,
        currentEpoch.toNumber(),
        deployment,
        activeAllocations.map((allocation) => allocation.id),
      )

      // Double-check whether the allocationID already exists on chain, to
      // avoid unnecessary transactions.
      // Note: We're checking the allocation state here, which is defined as
      //
      //     enum AllocationState { Null, Active, Closed, Finalized, Claimed }
      //
      // in the contracts.
      const state = await this.contracts.staking.getAllocationState(allocationId)
      if (state !== 0) {
        this.logger.debug(`Skipping allocation as it already exists onchain`, {
          indexer: this.indexer,
          allocation: allocationId,
          state,
        })
        throw new Error(`Allocation '${allocationId}' already exists onchain`)
      }

      this.logger.debug('Generating new allocation ID proof', {
        newAllocationSigner: allocationSigner,
        newAllocationID: allocationId,
        indexerAddress: this.indexer,
      })

      const proof = await allocationIdProof(allocationSigner, this.indexer, allocationId)

      this.logger.debug('Successfully generated allocation ID proof', {
        allocationIDProof: proof,
      })

      this.logger.debug(`Sending allocateFrom transaction`, {
        indexer: this.indexer,
        subgraphDeployment: deployment.ipfsHash,
        amount: formatGRT(amount),
        allocation: allocationId,
        proof,
      })

      const receipt = await this.transactionManager.executeTransaction(
        async () =>
          this.contracts.staking.estimateGas.allocateFrom(
            this.indexer,
            deployment.bytes32,
            amount,
            allocationId,
            utils.hexlify(Array(32).fill(0)),
            proof,
          ),
        async (gasLimit) =>
          this.contracts.staking.allocateFrom(
            this.indexer,
            deployment.bytes32,
            amount,
            allocationId,
            utils.hexlify(Array(32).fill(0)),
            proof,
            { gasLimit },
          ),
        this.logger.child({ action: 'allocate' }),
      )

      if (receipt === 'paused' || receipt === 'unauthorized') {
        throw new Error(
          `Allocation not created. ${
            receipt === 'paused' ? 'Network paused' : 'Operator not authorized'
          }`,
        )
      }

      const events = receipt.events || receipt.logs
      const event =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events.find((event: any) =>
          event.topics.includes(
            this.contracts.staking.interface.getEventTopic('AllocationCreated'),
          ),
        )
      if (!event) {
        throw indexerError(
          IndexerErrorCode.IE014,
          new Error(`Allocation was never mined`),
        )
      }

      const createEvent = this.contracts.staking.interface.decodeEventLog(
        'AllocationCreated',
        event.data,
        event.topics,
      )

      this.logger.info(`Successfully allocated to subgraph deployment`, {
        amountGRT: formatGRT(createEvent.tokens),
        allocation: createEvent.allocationID,
        epoch: createEvent.epoch.toString(),
      })

      // Remember allocation
      await this.receiptCollector.rememberAllocations([createEvent.allocationID])

      this.logger.debug(
        `Updating indexing rules, so indexer-agent will now manage the active allocation`,
      )
      const indexingRule = {
        identifier: deployment.ipfsHash,
        amount: amount.toString(),
        identifierType: SubgraphIdentifierType.DEPLOYMENT,
        decisionBasis: IndexingDecisionBasis.ALWAYS,
      } as Partial<IndexingRuleAttributes>

      await this.models.IndexingRule.upsert(indexingRule)

      // Since upsert succeeded, we _must_ have a rule
      const updatedRule = await this.models.IndexingRule.findOne({
        where: { identifier: indexingRule.identifier },
      })
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.logger.debug(`DecisionBasis.ALWAYS rule merged into indexing rules`, {
        rule: updatedRule,
      })

      return {
        deployment: deployment.ipfsHash,
        allocation: createEvent.allocationID,
        allocatedTokens: formatGRT(amount.toString()),
      }
    } catch (error) {
      this.logger.error(`Failed to allocate`, {
        amount: formatGRT(amount),
        error,
      })
      throw error
    }
  }

  async unallocate(
    allocationID: string,
    poi: string | undefined,
    force: boolean,
  ): Promise<CloseAllocationResult> {
    this.logger.info('Closing allocation', {
      allocationID: allocationID,
      poi: poi || 'none provided',
    })

    const allocation = await this.networkMonitor.allocation(allocationID)

    try {
      // Ensure allocation is old enough to close
      const currentEpoch = await this.contracts.epochManager.currentEpoch()
      if (BigNumber.from(allocation.createdAtEpoch).eq(currentEpoch)) {
        throw new Error(
          `Allocation '${allocation.id}' cannot be closed until epoch ${currentEpoch.add(
            1,
          )}. (Allocations cannot be closed in the same epoch they were created).`,
        )
      }

      poi = await this.networkMonitor.resolvePOI(allocation, poi, force)

      // Double-check whether the allocation is still active on chain, to
      // avoid unnecessary transactions.
      // Note: We're checking the allocation state here, which is defined as
      //
      //     enum AllocationState { Null, Active, Closed, Finalized, Claimed }
      //
      // in the contracts.
      const state = await this.contracts.staking.getAllocationState(allocation.id)
      if (state !== 1) {
        throw new Error('Allocation has already been closed')
      }

      this.logger.debug('Sending closeAllocation transaction')
      const receipt = await this.transactionManager.executeTransaction(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        () => this.contracts.staking.estimateGas.closeAllocation(allocation.id, poi!),
        (gasLimit) =>
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          this.contracts.staking.closeAllocation(allocation.id, poi!, {
            gasLimit,
          }),
        this.logger,
      )

      if (receipt === 'paused' || receipt === 'unauthorized') {
        throw new Error(`Allocation '${allocation.id}' could not be closed: ${receipt}`)
      }

      const events = receipt.events || receipt.logs

      const closeEvent =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events.find((event: any) =>
          event.topics.includes(
            this.contracts.staking.interface.getEventTopic('AllocationClosed'),
          ),
        )
      if (!closeEvent) {
        throw indexerError(
          IndexerErrorCode.IE014,
          new Error(`Allocation close transaction was never successfully mined`),
        )
      }
      const closeAllocationEventLogs = this.contracts.staking.interface.decodeEventLog(
        'AllocationClosed',
        closeEvent.data,
        closeEvent.topics,
      )

      const rewardsEvent =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events.find((event: any) =>
          event.topics.includes(
            this.contracts.rewardsManager.interface.getEventTopic('RewardsAssigned'),
          ),
        )
      const rewardsAssigned = rewardsEvent
        ? this.contracts.rewardsManager.interface.decodeEventLog(
            'RewardsAssigned',
            rewardsEvent.data,
            rewardsEvent.topics,
          ).amount
        : 0

      if (rewardsAssigned == 0) {
        this.logger.warn('No rewards were distributed upon closing the allocation')
      }

      this.logger.info(`Successfully closed allocation`, {
        deployment: closeAllocationEventLogs.subgraphDeploymentID,
        allocation: closeAllocationEventLogs.allocationID,
        indexer: closeAllocationEventLogs.indexer,
        amountGRT: formatGRT(closeAllocationEventLogs.tokens),
        effectiveAllocation: closeAllocationEventLogs.effectiveAllocation.toString(),
        poi: closeAllocationEventLogs.poi,
        epoch: closeAllocationEventLogs.epoch.toString(),
        transaction: receipt.transactionHash,
        indexingRewards: rewardsAssigned,
      })

      this.logger.info('Identifying receipts worth collecting', {
        allocation: closeAllocationEventLogs.allocationID,
      })

      // Collect query fees for this allocation
      const isCollectingQueryFees = await this.receiptCollector.collectReceipts(
        allocation,
      )

      this.logger.debug(
        `Updating indexing rules, so indexer-agent keeps the deployment synced but doesn't reallocate to it`,
      )
      const offchainIndexingRule = {
        identifier: allocation.subgraphDeployment.id.ipfsHash,
        identifierType: SubgraphIdentifierType.DEPLOYMENT,
        decisionBasis: IndexingDecisionBasis.OFFCHAIN,
      } as Partial<IndexingRuleAttributes>

      await this.models.IndexingRule.upsert(offchainIndexingRule)

      // Since upsert succeeded, we _must_ have a rule
      const updatedRule = await this.models.IndexingRule.findOne({
        where: { identifier: offchainIndexingRule.identifier },
      })
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.logger.info(`DecisionBasis.OFFCHAIN rule merged into indexing rules`, {
        rule: updatedRule,
      })

      return {
        allocation: closeAllocationEventLogs.allocationID,
        allocatedTokens: formatGRT(closeAllocationEventLogs.tokens),
        indexingRewards: formatGRT(rewardsAssigned),
        receiptsWorthCollecting: isCollectingQueryFees,
      }
    } catch (error) {
      const err = indexerError(IndexerErrorCode.IE015, error)
      this.logger.warn(`Failed to close allocation`, {
        err,
      })
      throw err
    }
  }

  async reallocate(
    allocationID: string,
    poi: string | undefined,
    amount: BigNumber,
    force: boolean,
  ): Promise<ReallocateAllocationResult> {
    const logger = this.logger.child({
      component: 'reallocateAllocationResolver',
    })

    logger.info('Reallocating allocation', {
      allocation: allocationID,
      poi: poi || 'none provided',
      amount,
      force,
    })

    let activeAllocations: Allocation[] = []

    // Fetch active allocations
    try {
      const result = await this.networkSubgraph.query(
        gql`
          query allocations($indexer: String!, $status: AllocationStatus!) {
            allocations(where: { indexer: $indexer, status: $status }, first: 1000) {
              id
              indexer {
                id
              }
              allocatedTokens
              createdAtEpoch
              closedAtEpoch
              createdAtBlockHash
              subgraphDeployment {
                id
                stakedTokens
                signalledTokens
              }
            }
          }
        `,
        {
          indexer: this.indexer.toLocaleLowerCase(),
          status: AllocationStatus[AllocationStatus.Active],
        },
      )

      if (result.error) {
        throw result.error
      }
      if (result.data.allocations.length > 0) {
        activeAllocations = result.data.allocations.map(parseGraphQLAllocation)
      }
    } catch (error) {
      const err = indexerError(IndexerErrorCode.IE010, error)
      logger.error(`Failed to query active indexer allocations`, {
        err,
      })
      throw err
    }

    const allocationAddress = toAddress(allocationID)
    const allocation = activeAllocations.find((allocation) => {
      return allocation.id === allocationAddress
    })

    if (!allocation) {
      logger.error(`No existing `)
      throw new Error(
        `Allocation cannot be refreshed. No active allocation with id '${allocationID}' found.`,
      )
    }

    try {
      // Ensure allocation is old enough to close
      const currentEpoch = await this.contracts.epochManager.currentEpoch()
      if (BigNumber.from(allocation.createdAtEpoch).eq(currentEpoch)) {
        throw new Error(
          `Allocation '${allocation.id}' cannot be closed until epoch ${currentEpoch.add(
            1,
          )}. (Allocations cannot be closed in the same epoch they were created).`,
        )
      }

      logger.debug('Resolving POI')
      const allocationPOI = await this.networkMonitor.resolvePOI(allocation, poi, force)
      logger.debug('POI resolved', {
        userProvidedPOI: poi,
        poi: allocationPOI,
      })

      // Double-check whether the allocation is still active on chain, to
      // avoid unnecessary transactions.
      // Note: We're checking the allocation state here, which is defined as
      //
      //     enum AllocationState { Null, Active, Closed, Finalized, Claimed }
      //
      // in the this.contracts.
      const state = await this.contracts.staking.getAllocationState(allocation.id)
      if (state !== 1) {
        logger.warn(`Allocation has already been closed`)
        throw new Error(`Allocation has already been closed`)
      }

      if (amount.lt('0')) {
        logger.warn('Cannot reallocate a negative amount of GRT', {
          amount: amount.toString(),
        })
        throw new Error('Cannot reallocate a negative amount of GRT')
      }

      if (amount.eq('0')) {
        logger.warn('Cannot reallocate zero GRT, skipping this allocation', {
          amount: amount.toString(),
        })
        throw new Error(`Cannot reallocate zero GRT`)
      }

      logger.info(`Reallocate to subgraph deployment`, {
        existingAllocationAmount: formatGRT(allocation.allocatedTokens),
        newAllocationAmount: formatGRT(amount),
        epoch: currentEpoch.toString(),
      })

      // Identify how many GRT the indexer has staked
      const freeStake = await this.contracts.staking.getIndexerCapacity(this.indexer)

      // When reallocating, we will first close the old allocation and free up the GRT in that allocation
      // This GRT will be available in addition to freeStake for the new allocation
      const postCloseFreeStake = freeStake.add(allocation.allocatedTokens)

      // If there isn't enough left for allocating, abort
      if (postCloseFreeStake.lt(amount)) {
        throw indexerError(
          IndexerErrorCode.IE013,
          new Error(
            `Unable to allocate ${formatGRT(
              amount,
            )} GRT: indexer only has a free stake amount of ${formatGRT(
              freeStake,
            )} GRT, plus ${formatGRT(
              allocation.allocatedTokens,
            )} GRT from the existing allocation`,
          ),
        )
      }

      logger.debug('Generating a new unique Allocation ID')
      const { allocationSigner, allocationId: newAllocationId } = uniqueAllocationID(
        this.transactionManager.wallet.mnemonic.phrase,
        currentEpoch.toNumber(),
        allocation.subgraphDeployment.id,
        activeAllocations.map((allocation) => allocation.id),
      )

      logger.debug('New unique Allocation ID generated', {
        newAllocationID: newAllocationId,
        newAllocationSigner: allocationSigner,
      })

      // Double-check whether the allocationID already exists on chain, to
      // avoid unnecessary transactions.
      // Note: We're checking the allocation state here, which is defined as
      //
      //     enum AllocationState { Null, Active, Closed, Finalized, Claimed }
      //
      // in the this.contracts.
      const newAllocationState = await this.contracts.staking.getAllocationState(
        newAllocationId,
      )
      if (newAllocationState !== 0) {
        logger.warn(`Skipping Allocation as it already exists onchain`, {
          indexer: this.indexer,
          allocation: newAllocationId,
          newAllocationState,
        })
        throw new Error('AllocationID already exists')
      }

      logger.debug('Generating new allocation ID proof', {
        newAllocationSigner: allocationSigner,
        newAllocationID: newAllocationId,
        indexerAddress: this.indexer,
      })
      const proof = await allocationIdProof(
        allocationSigner,
        this.indexer,
        newAllocationId,
      )
      logger.debug('Successfully generated allocation ID proof', {
        allocationIDProof: proof,
      })

      logger.info(`Sending closeAndAllocate transaction`, {
        indexer: this.indexer,
        amount: formatGRT(amount),
        oldAllocation: allocation.id,
        newAllocation: newAllocationId,
        newAllocationAmount: formatGRT(amount),
        deployment: allocation.subgraphDeployment.id.toString(),
        poi: allocationPOI,
        proof,
        epoch: currentEpoch.toString(),
      })

      const receipt = await this.transactionManager.executeTransaction(
        async () =>
          this.contracts.staking.estimateGas.closeAndAllocate(
            allocation.id,
            allocationPOI,
            this.indexer,
            allocation.subgraphDeployment.id.bytes32,
            amount,
            newAllocationId,
            utils.hexlify(Array(32).fill(0)), // metadata
            proof,
          ),
        async (gasLimit) =>
          this.contracts.staking.closeAndAllocate(
            allocation.id,
            allocationPOI,
            this.indexer,
            allocation.subgraphDeployment.id.bytes32,
            amount,
            newAllocationId,
            utils.hexlify(Array(32).fill(0)), // metadata
            proof,
            { gasLimit },
          ),
        logger.child({ action: 'closeAndAllocate' }),
      )

      if (receipt === 'paused' || receipt === 'unauthorized') {
        throw new Error(`Allocation '${newAllocationId}' could not be closed: ${receipt}`)
      }

      const events = receipt.events || receipt.logs
      const createEvent =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events.find((event: any) =>
          event.topics.includes(
            this.contracts.staking.interface.getEventTopic('AllocationCreated'),
          ),
        )
      if (!createEvent) {
        throw indexerError(
          IndexerErrorCode.IE014,
          new Error(`Allocation was never mined`),
        )
      }

      const createAllocationEventLogs = this.contracts.staking.interface.decodeEventLog(
        'AllocationCreated',
        createEvent.data,
        createEvent.topics,
      )

      const closeEvent =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events.find((event: any) =>
          event.topics.includes(
            this.contracts.staking.interface.getEventTopic('AllocationClosed'),
          ),
        )
      if (!closeEvent) {
        throw indexerError(
          IndexerErrorCode.IE014,
          new Error(`Allocation close transaction was never successfully mined`),
        )
      }
      const closeAllocationEventLogs = this.contracts.staking.interface.decodeEventLog(
        'AllocationClosed',
        closeEvent.data,
        closeEvent.topics,
      )

      const rewardsEvent =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events.find((event: any) =>
          event.topics.includes(
            this.contracts.rewardsManager.interface.getEventTopic('RewardsAssigned'),
          ),
        )
      const rewardsAssigned = rewardsEvent
        ? this.contracts.rewardsManager.interface.decodeEventLog(
            'RewardsAssigned',
            rewardsEvent.data,
            rewardsEvent.topics,
          ).amount
        : 0

      if (rewardsAssigned == 0) {
        logger.warn('No rewards were distributed upon closing the allocation')
      }

      logger.info(`Successfully reallocated allocation`, {
        deployment: createAllocationEventLogs.subgraphDeploymentID,
        closedAllocation: closeAllocationEventLogs.allocationID,
        closedAllocationStakeGRT: formatGRT(closeAllocationEventLogs.tokens),
        closedAllocationPOI: closeAllocationEventLogs.poi,
        closedAllocationEpoch: closeAllocationEventLogs.epoch.toString(),
        indexingRewardsCollected: rewardsAssigned,
        createdAllocation: createAllocationEventLogs.allocationID,
        createdAllocationStakeGRT: formatGRT(createAllocationEventLogs.tokens),
        indexer: createAllocationEventLogs.indexer,
        epoch: createAllocationEventLogs.epoch.toString(),
        transaction: receipt.transactionHash,
      })

      logger.info('Identifying receipts worth collecting', {
        allocation: closeAllocationEventLogs.allocationID,
      })

      // Collect query fees for this allocation
      const isCollectingQueryFees = await this.receiptCollector.collectReceipts(
        allocation,
      )

      logger.debug(
        `Updating indexing rules, so indexer-agent will manage the active allocation`,
      )
      const indexingRule = {
        identifier: allocation.subgraphDeployment.id.ipfsHash,
        amount: amount.toString(),
        identifierType: SubgraphIdentifierType.DEPLOYMENT,
        decisionBasis: IndexingDecisionBasis.ALWAYS,
      } as Partial<IndexingRuleAttributes>

      await this.models.IndexingRule.upsert(indexingRule)

      // Since upsert succeeded, we _must_ have a rule
      const updatedRule = await this.models.IndexingRule.findOne({
        where: { identifier: indexingRule.identifier },
      })
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      logger.debug(`DecisionBasis.ALWAYS rule merged into indexing rules`, {
        rule: updatedRule,
      })

      return {
        closedAllocation: closeAllocationEventLogs.allocationID,
        indexingRewardsCollected: formatGRT(rewardsAssigned),
        receiptsWorthCollecting: isCollectingQueryFees,
        createdAllocation: createAllocationEventLogs.allocationID,
        createdAllocationStake: formatGRT(createAllocationEventLogs.tokens),
      }
    } catch (error) {
      logger.error(error.toString())
      throw error
    }
  }

  async collect(allocationID: string): Promise<boolean> {
    const allocation = await this.networkMonitor.allocation(allocationID)
    return await this.receiptCollector.collectReceipts(allocation)
  }
}
