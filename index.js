/* eslint-disable no-await-in-loop */
const BigNumber = require('bignumber.js');
const LIKECOIN = require('./constant/contract/likecoin');
const { web3, sendTransactionWithLoop: sendEthTransactionWithLoop } = require('./util/web3');
const {
  db,
  userCollection: userRef,
  payoutCollection: payoutRef,
} = require('./util/firebase');
const {
  logEthPayoutTx,
  logCosmosPayoutTx,
} = require('./util/logger');
const publisher = require('./util/gcloudPub');
const config = require('./config/config.js');
const { startPoller } = require('./util/poller');
const {
  getCurrentHeight,
  isCosmosWallet,
  sendTransactionWithLoop: sendCosmosTransaction,
} = require('./util/cosmos');

const PUBSUB_TOPIC_MISC = 'misc';
const ONE_LIKE = new BigNumber(10).pow(18);
const ONE_COSMOS_LIKE = new BigNumber(10).pow(9);
const LikeCoin = new web3.eth.Contract(LIKECOIN.LIKE_COIN_ABI, LIKECOIN.LIKE_COIN_ADDRESS);

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeNewRecevier(wallet, user) {
  return {
    wallet,
    user,
    payoutIds: [],
    payoutDatas: [],
    value: new BigNumber(0),
  };
}

function sendEthTransaction(wallet, value) {
  const methodCall = LikeCoin.methods.transfer(wallet, value);
  const txData = methodCall.encodeABI();
  return sendEthTransactionWithLoop(
    LIKECOIN.LIKE_COIN_ADDRESS,
    txData,
  );
}

async function handleQuery(docs) {
  const senderMap = {};
  docs.forEach((ref) => {
    const d = ref.data();
    if (!d.to) {
      return; // wait for user to bind wallet
    }
    if (!d.value) {
      console.error(`handleQuery(): ${ref.id} has no value`); // eslint-disable-line no-console
      return;
    }
    if (!senderMap[d.to]) {
      senderMap[d.to] = makeNewRecevier(d.to, d.toId);
    }
    senderMap[d.to].payoutIds.push(ref.id);
    senderMap[d.to].payoutDatas.push(d);
    senderMap[d.to].value = senderMap[d.to].value.plus(new BigNumber(d.value));
  });
  const receivers = Object.keys(senderMap);
  for (let i = 0; i < receivers.length; i += 1) {
    try {
      const wallet = receivers[i];
      const data = senderMap[wallet];
      const {
        user,
        payoutIds,
        payoutDatas,
        value,
        delegatorAccount,
      } = data;
      await db.runTransaction(t => Promise.all(payoutIds.map(async (payoutId) => {
        const ref = payoutRef.doc(payoutId);
        const d = await t.get(ref);
        if (d.data().txHash) throw new Error('set claim fail');
      })).then(() => Promise.all(payoutIds.map(async (payoutId) => {
        const ref = payoutRef.doc(payoutId);
        await t.update(ref, {
          txHash: 'pending',
        });
      }))));

      const isCosmos = isCosmosWallet(wallet);
      let tx;
      let txHash;
      let pendingCount;
      let gasPrice;
      let gas;
      let delegatorAddress;
      if (isCosmos) {
        const cosmosValue = value.dividedBy(ONE_LIKE).times(ONE_COSMOS_LIKE);
        ({
          tx,
          txHash,
          pendingCount,
          gas,
          delegatorAddress,
        } = await sendCosmosTransaction(wallet, cosmosValue.toFixed()));
      } else {
        ({
          tx,
          txHash,
          pendingCount, gasPrice,
          delegatorAddress,
        } = await sendEthTransaction(wallet, value));
      }

      const batch = db.batch();
      payoutIds.forEach((payoutId) => {
        const ref = payoutRef.doc(payoutId);
        batch.update(ref, { txHash });
      });
      batch.commit();
      const remarks = payoutDatas.map(d => d.remarks).filter(r => !!r);
      let currentBlock;
      if (isCosmos) {
        currentBlock = await getCurrentHeight();
        await logCosmosPayoutTx({
          txHash,
          from: delegatorAddress,
          to: wallet,
          value: value.toString(),
          fromId: delegatorAccount || delegatorAddress,
          toId: user,
          currentBlock,
          sequence: pendingCount,
          delegatorAddress,
          remarks: (remarks && remarks.length) ? remarks : 'Bonus',
        });
      } else {
        currentBlock = await web3.eth.getBlockNumber();
        await logEthPayoutTx({
          txHash,
          from: delegatorAddress,
          to: wallet,
          value: value.toString(),
          fromId: delegatorAccount || delegatorAddress,
          toId: user,
          currentBlock,
          nonce: pendingCount,
          rawSignedTx: tx.rawTransaction,
          delegatorAddress: web3.utils.toChecksumAddress(delegatorAddress),
          remarks: (remarks && remarks.length) ? remarks : 'Bonus',
        });
      }
      const receiverDoc = await userRef.doc(user).get();
      const {
        referrer: toReferrer,
        timestamp: toRegisterTime,
      } = receiverDoc.data();
      if (isCosmos) {
        publisher.publish(PUBSUB_TOPIC_MISC, null, {
          logType: 'eventCosmosPayout',
          fromUser: delegatorAccount || delegatorAddress,
          fromWallet: delegatorAddress,
          toUser: user,
          toWallet: wallet,
          toReferrer,
          toRegisterTime,
          likeAmount: value.dividedBy(ONE_LIKE).toNumber(),
          likeAmountUnitStr: value.toString(),
          txHash,
          txStatus: 'pending',
          txSequence: pendingCount,
          gas,
          currentBlock,
          delegatorAddress,
        });
      } else {
        publisher.publish(PUBSUB_TOPIC_MISC, null, {
          logType: 'eventPayout',
          fromUser: delegatorAccount || delegatorAddress,
          fromWallet: delegatorAddress,
          toUser: user,
          toWallet: wallet,
          toReferrer,
          toRegisterTime,
          likeAmount: value.dividedBy(ONE_LIKE).toNumber(),
          likeAmountUnitStr: value.toString(),
          txHash,
          txStatus: 'pending',
          txNonce: pendingCount,
          gasPrice,
          currentBlock,
          delegatorAddress: web3.utils.toChecksumAddress(delegatorAddress),
        });
      }
    } catch (err) {
      console.error('handleQuery()', err); // eslint-disable-line no-console
    }
  }
}

async function loop() {
  while (true) { // eslint-disable-line no-constant-condition
    try {
      const query = await payoutRef.where('waitForClaim', '==', false)
        .where('effectiveTs', '<', Date.now())
        .where('txHash', '==', null)
        .limit(250)
        .get();
      await handleQuery(query.docs);
    } catch (err) {
      console.error('loop():', err); // eslint-disable-line no-console
    } finally {
      await timeout(config.POLLING_DELAY || 10000);
    }
  }
}

startPoller();
loop();
