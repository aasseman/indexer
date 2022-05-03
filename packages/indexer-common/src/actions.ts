export interface ActionParamsInput {
  deploymentID?: string
  allocationID?: string
  amount?: string
  poi?: string
  force?: boolean
}

export interface ActionItem {
  params: ActionParamsInput
  type: ActionType
}

export interface ActionInput {
  type: ActionType
  deploymentID?: string
  allocationID?: string
  amount?: string
  poi?: string
  force?: boolean
  source: string
  reason: string
  status: ActionStatus
  priority: number | undefined
}

export interface ActionFilter {
  type?: ActionType | undefined
  status?: ActionStatus | undefined
  source?: string | undefined
  reason?: string | undefined
}

export interface ActionResult {
  type: ActionType
  deploymentID: string | null
  allocationID: string | null
  amount: string | null
  poi: string | null
  force: boolean | null
  source: string
  reason: string
  status: ActionStatus
  priority: number | undefined
}

export enum ActionType {
  ALLOCATE = 'allocate',
  UNALLOCATE = 'unallocate',
  REALLOCATE = 'reallocate',
  COLLECT = 'collect',
}

export enum ActionStatus {
  QUEUED = 'queued',
  APPROVED = 'approved',
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  CANCELED = 'canceled',
}
