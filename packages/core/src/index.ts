export {
  TREE_DEPTH,
  EMPTY_LEAF,
  ensureHex,
  computeZeroHashes,
  buildMerkleTree,
  computeRoot,
  type Hash2,
  type MerkleProof,
} from "./tree.js";

export {
  getRpcServer,
  queryContractView,
  fetchCommitmentsFromChain,
  scanDepositEventsPage,
  scanWithdrawEventsPage,
  type ChainConfig,
  type DepositEvent,
  type WithdrawEvent,
  type EventScanCursor,
  type ScanResult,
} from "./chain.js";
