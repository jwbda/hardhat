import { Common } from "@nomicfoundation/ethereumjs-common";
import {
  StateManager,
  DefaultStateManager,
} from "@nomicfoundation/ethereumjs-statemanager";
import { Account, Address, toBuffer } from "@nomicfoundation/ethereumjs-util";
import { assert } from "chai";

import { InvalidInputError } from "../../../../src/internal/core/providers/errors";
import { randomAddress } from "../../../../src/internal/hardhat-network/provider/utils/random";
import { txMapToArray } from "../../../../src/internal/hardhat-network/provider/utils/txMapToArray";
import { assertEqualTransactionMaps } from "../helpers/assertEqualTransactionMaps";
import {
  createTestFakeTransaction,
  createTestOrderedTransaction,
  createTestTransaction,
} from "../helpers/blockchain";
import { makeOrderedTxMap } from "../helpers/makeOrderedTxMap";
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_ACCOUNTS_ADDRESSES,
} from "../helpers/providers";

describe("Tx Pool", () => {
  const blockGasLimit = 10_000_000n;
  let stateManager: StateManager;
  let txPool: HardhatMemPool;

  beforeEach(() => {
    stateManager = new DefaultStateManager();
    const common = new Common({ chain: "mainnet" });
    txPool = new HardhatMemPool(blockGasLimit, common, stateManager);
  });

  describe("update", () => {
    const address1 = Address.fromString(DEFAULT_ACCOUNTS_ADDRESSES[0]);
    const address2 = Address.fromString(DEFAULT_ACCOUNTS_ADDRESSES[1]);
    beforeEach(async () => {
      await stateManager.putAccount(
        address1,
        Account.fromAccountData({
          nonce: 0n,
          balance: 10n ** 18n,
        })
      );
      await stateManager.putAccount(
        address2,
        Account.fromAccountData({
          nonce: 0n,
          balance: 10n ** 18n,
        })
      );
    });

    it("removes queued transaction when sender doesn't have enough ether to make the transaction", async () => {
      const tx1 = createTestTransaction({
        nonce: 2,
        gasLimit: 30_000,
        gasPrice: 500,
      });
      const signedTx1 = tx1.sign(toBuffer(DEFAULT_ACCOUNTS[0].privateKey));

      await txPool.addTransaction(signedTx1);

      await stateManager.putAccount(
        address1,
        Account.fromAccountData({ nonce: 0n, balance: 0n })
      );

      await txPool.update();
      const queuedTransactions = txPool.getOrderedQueuedTransactions();

      assertEqualTransactionMaps(queuedTransactions, makeOrderedTxMap([]));
    });

    it("moves pending transactions to queued if needed", async () => {
      const sender = randomAddress();
      await stateManager.putAccount(
        sender,
        Account.fromAccountData({
          nonce: 0n,
          balance: 10n ** 20n,
        })
      );

      const tx0 = createTestFakeTransaction({
        nonce: 0,
        gasLimit: 100_000,
        from: sender,
      });
      const tx1 = createTestFakeTransaction({
        nonce: 1,
        gasLimit: 200_000,
        from: sender,
      });
      const tx2 = createTestFakeTransaction({
        nonce: 2,
        gasLimit: 100_000,
        from: sender,
      });
      const tx4 = createTestFakeTransaction({
        nonce: 4,
        gasLimit: 100_000,
        from: sender,
      });
      const tx5 = createTestFakeTransaction({
        nonce: 5,
        gasLimit: 100_000,
        from: sender,
      });

      await txPool.addTransaction(tx0);
      await txPool.addTransaction(tx1);
      await txPool.addTransaction(tx2);
      await txPool.addTransaction(tx4);
      await txPool.addTransaction(tx5);

      // pending: [0, 1, 2]
      // queued: [4, 5]
      let pendingTxs = txPool.getOrderedPendingTransactions();
      assert.lengthOf(txMapToArray(pendingTxs), 3);
      assert.deepEqual(txMapToArray(pendingTxs)[0].raw, tx0.raw);
      assert.deepEqual(txMapToArray(pendingTxs)[1].raw, tx1.raw);
      assert.deepEqual(txMapToArray(pendingTxs)[2].raw, tx2.raw);

      let queuedTxs = txPool.getOrderedQueuedTransactions();
      assert.lengthOf(txMapToArray(queuedTxs), 2);
      assert.deepEqual(txMapToArray(queuedTxs)[0].raw, tx4.raw);
      assert.deepEqual(txMapToArray(queuedTxs)[1].raw, tx5.raw);

      // this should drop tx1
      await txPool.setBlockGasLimit(150_000n);

      // pending: [0]
      // queued: [2, 4, 5]
      pendingTxs = txPool.getOrderedPendingTransactions();
      assert.lengthOf(txMapToArray(pendingTxs), 1);
      assert.deepEqual(txMapToArray(pendingTxs)[0].raw, tx0.raw);

      queuedTxs = txPool.getOrderedQueuedTransactions();
      assert.lengthOf(txMapToArray(queuedTxs), 3);
      assert.deepEqual(txMapToArray(queuedTxs)[0].raw, tx4.raw);
      assert.deepEqual(txMapToArray(queuedTxs)[1].raw, tx5.raw);
      assert.deepEqual(txMapToArray(queuedTxs)[2].raw, tx2.raw);
    });

    it("handles dropped transactions properly", async () => {
      const sender = randomAddress();

      const tx1 = createTestFakeTransaction({
        nonce: 0,
        gasLimit: 100_000,
        from: sender,
      });
      await txPool.addTransaction(tx1);

      let pendingTxs = txPool.getOrderedPendingTransactions();
      assert.lengthOf(txMapToArray(pendingTxs), 1);
      assert.deepEqual(txMapToArray(pendingTxs)[0].raw, tx1.raw);

      let queuedTxs = txPool.getOrderedQueuedTransactions();
      assert.lengthOf(txMapToArray(queuedTxs), 0);

      await txPool.setBlockGasLimit(90_000n);

      const tx2 = createTestFakeTransaction({
        gasLimit: 80_000,
        from: sender,
        nonce: 0,
      });
      await txPool.addTransaction(tx2);

      pendingTxs = txPool.getOrderedPendingTransactions();
      assert.lengthOf(txMapToArray(pendingTxs), 1);
      assert.deepEqual(txMapToArray(pendingTxs)[0].raw, tx2.raw);

      queuedTxs = txPool.getOrderedQueuedTransactions();
      assert.lengthOf(txMapToArray(queuedTxs), 0);
    });

    it("accepts transactions after a no-op update", async function () {
      const sender = randomAddress();
      await stateManager.putAccount(
        sender,
        Account.fromAccountData({
          nonce: 0n,
          balance: 10n ** 20n,
        })
      );

      const tx0 = createTestFakeTransaction({
        nonce: 0,
        from: sender,
      });
      const tx1 = createTestFakeTransaction({
        nonce: 1,
        from: sender,
      });
      const tx2 = createTestFakeTransaction({
        nonce: 2,
        from: sender,
      });

      await txPool.addTransaction(tx0);
      await txPool.addTransaction(tx1);
      await txPool.addTransaction(tx2);

      // pending: [0, 1, 2]
      // queued: [0]
      let pendingTxs = txPool.getOrderedPendingTransactions();
      assert.lengthOf(txMapToArray(pendingTxs), 3);
      assert.deepEqual(txMapToArray(pendingTxs)[0].raw, tx0.raw);
      assert.deepEqual(txMapToArray(pendingTxs)[1].raw, tx1.raw);
      assert.deepEqual(txMapToArray(pendingTxs)[2].raw, tx2.raw);

      let queuedTxs = txPool.getOrderedQueuedTransactions();
      assert.lengthOf(txMapToArray(queuedTxs), 0);

      // this should drop tx1
      await txPool.setBlockGasLimit(100_000n);

      const tx3 = createTestFakeTransaction({
        nonce: 3,
        from: sender,
      });
      await txPool.addTransaction(tx3);

      // pending: [0, 1, 2, 3]
      // queued: []
      pendingTxs = txPool.getOrderedPendingTransactions();
      assert.lengthOf(txMapToArray(pendingTxs), 4);
      assert.deepEqual(txMapToArray(pendingTxs)[0].raw, tx0.raw);
      assert.deepEqual(txMapToArray(pendingTxs)[1].raw, tx1.raw);
      assert.deepEqual(txMapToArray(pendingTxs)[2].raw, tx2.raw);
      assert.deepEqual(txMapToArray(pendingTxs)[3].raw, tx3.raw);

      queuedTxs = txPool.getOrderedQueuedTransactions();
      assert.lengthOf(txMapToArray(queuedTxs), 0);
    });
  });

  describe("setBlockGasLimit", () => {
    it("sets a new block gas limit when new limit is a number", async () => {
      assert.equal(await txPool.getBlockGasLimit(), 10_000_000n);
      await txPool.setBlockGasLimit(15_000_000n);
      assert.equal(await txPool.getBlockGasLimit(), 15_000_000n);
    });

    it("sets a new block gas limit when new limit is a bigint", async () => {
      assert.equal(await txPool.getBlockGasLimit(), 10_000_000n);
      await txPool.setBlockGasLimit(15_000_000n);
      assert.equal(await txPool.getBlockGasLimit(), 15_000_000n);
    });

    it("makes the new block gas limit actually used for validating added transactions", async () => {
      await txPool.setBlockGasLimit(21_000n);
      const tx = createTestFakeTransaction({ gasLimit: 50_000 });
      await assert.isRejected(
        txPool.addTransaction(tx),
        InvalidInputError,
        "Transaction gas limit is 50000 and exceeds block gas limit of 21000"
      );
    });
  });

  describe("snapshot", () => {
    it("returns a snapshot id", async () => {
      const id = await txPool.makeSnapshot();
      assert.isNumber(id);
    });

    it("returns a bigger snapshot id if the state changed", async () => {
      const id1 = await txPool.makeSnapshot();
      const tx = createTestFakeTransaction();
      await txPool.addTransaction(tx);
      const id2 = await txPool.makeSnapshot();
      assert.isAbove(id2, id1);
    });
  });

  describe("revert", () => {
    it("throws if snapshot with given ID doesn't exist", async () => {
      await assert.isRejected(
        txPool.revertToSnapshot(5),
        Error,
        "There's no snapshot with such ID"
      );
    });

    it("reverts to the previous state of transactions", async () => {
      const address = randomAddress();
      await stateManager.putAccount(
        address,
        Account.fromAccountData({ nonce: 0n })
      );
      const tx1 = createTestOrderedTransaction({
        from: address,
        orderId: 0,
        nonce: 0,
      });
      await txPool.addTransaction(tx1.data);

      const id = await txPool.makeSnapshot();

      const tx2 = createTestOrderedTransaction({
        from: address,
        orderId: 1,
        nonce: 1,
      });
      await txPool.addTransaction(tx2.data);

      await txPool.revertToSnapshot(id);
      const pendingTransactions = txPool.getOrderedPendingTransactions();
      assertEqualTransactionMaps(pendingTransactions, makeOrderedTxMap([tx1]));
    });

    it("reverts to the previous state of block gas limit", async () => {
      const id = await txPool.makeSnapshot();
      await txPool.setBlockGasLimit(5_000_000n);
      await txPool.revertToSnapshot(id);
      assert.equal(await txPool.getBlockGasLimit(), blockGasLimit);
    });
  });

  describe("hasPendingTransactions", () => {
    it("returns false when there are no pending transactions", async () => {
      assert.isFalse(await txPool.hasPendingTransactions());
    });

    it("returns true when there is at least one pending transaction", async () => {
      const tx1 = createTestFakeTransaction({ nonce: 0 });
      const tx2 = createTestFakeTransaction({ nonce: 0 });

      await txPool.addTransaction(tx1);
      assert.isTrue(await txPool.hasPendingTransactions());

      await txPool.addTransaction(tx2);
      assert.isTrue(await txPool.hasPendingTransactions());
    });

    it("returns false when there are only queued transactions", async () => {
      const tx1 = createTestFakeTransaction({ nonce: 1 });
      const tx2 = createTestFakeTransaction({ nonce: 1 });
      await txPool.addTransaction(tx1);
      await txPool.addTransaction(tx2);

      assert.isFalse(await txPool.hasPendingTransactions());
    });
  });
});
