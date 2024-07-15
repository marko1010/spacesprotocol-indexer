import { SimpleRpcClient } from './rpc.js';
import { spaces, spacesHistory, blocks, transactions, syncs } from './schema.js';
import { getDb } from './db.js';
import fs from 'fs/promises';
import { sql, desc } from 'drizzle-orm';
import { performance } from 'perf_hooks';
import cron from 'node-cron';

type NewSpaceHistory = typeof spacesHistory.$inferInsert;

interface TransactionOutput {
    name?: string;
    outpoint?: string;
    covenant?: any;
}

interface MetaOutput {
    name?: string;
    action?: string;
    target?: {
        name: string;
    };
    covenant?: any;
    bid_value?: number;
}

interface Transaction {
    txid: string;
    version: number;
    vout: TransactionOutput[];
    vmetaout: MetaOutput[];
}

interface Block {
    hash: string,
    confirmations: number,
    height: number,
    version: number,
    versionHex: string,
    merkleroot: string,
    time: number,
    mediantime: number,
    nonce: number,
    bits: string,
    difficulty: number,
    chainwork: string,
    nTx: number,
    previousblockhash: string,
    nextblockhash: string,
    strippedsize: number,
    size: number,
    weight: number,
}

class SimpleIndexer {
    public nameHistory: { [key: string]: (TransactionOutput | MetaOutput)[] };

    constructor() {
        this.nameHistory = {};
    }

    /**
     * Process block
     * @param height the block height
     * @param blockHash the block hash
     * @param block the Bitcoin block data
     * @param spaceTxs any transactions relevant to Spaces in this block
     */
    async processBlock(block: Block, spaceTxs: Transaction[], db): Promise<void> {
        if (spaceTxs.length === 0) {
            // No spaces transactions in this block
            return;
        }

        try {
            await db.transaction(async (dbTx) => {
                const blockDB = await dbTx.insert(blocks).values({
                    hash: block.hash,
                    confirmations: block.confirmations,
                    height: block.height,
                    version: block.version,
                    merkleroot: block.merkleroot,
                    time: block.time,
                    mediantime: block.mediantime,
                    nonce: block.nonce,
                    bits: block.bits,
                    difficulty: block.difficulty.toString(),
                    chainwork: block.chainwork,
                    nTx: block.nTx,
                    previousblockhash: block.previousblockhash,
                    nextblockhash: block.nextblockhash,
                    strippedsize: block.strippedsize,
                    size: block.size,
                    weight: block.weight,
                }).returning({ insertedBlockId: blocks.id });

                const transactionsDb = await dbTx.insert(transactions).values(spaceTxs.map(x => ({
                    txid: x.txid,
                    version: x.version,
                    blockId: blockDB[0].insertedBlockId,
                    blockHash: block.hash,
                    data: x,
                }))).returning();

                for (let tx of spaceTxs) {
                    for (let vout of tx.vout) {
                        if (!vout.name || vout.covenant?.type !== 'transfer') continue;
                        let spaceDb = (await dbTx.select().from(spaces).where(sql`${spaces.name} = ${vout.name}`))?.[0];

                        const historyRecord = (await dbTx.insert(spacesHistory).values({
                            spaceName: spaceDb.name,
                            spaceId: spaceDb.id,
                            transactionId: transactionsDb.find(x => x.txid === tx.txid).id,
                            txid: tx.txid,
                            action: 'transfer',
                            bid_amount: null,
                            meta: vout
                        }).returning())?.[0];

                        if (spaceDb.status != 'registered')
                            await dbTx.update(spaces).set({ status: 'registered', spacesHistoryId: historyRecord.id, updatedAt: sql`now()` }).where(sql`${spaces.id} = ${spaceDb.id}`);
                    }

                    for (let meta of tx.vmetaout) {
                        const name = meta.name || meta.target?.name;
                        if (!name) continue;

                        let newSpaceStatus = null
                        let spaceDb = (await dbTx.select().from(spaces).where(sql`${spaces.name} = ${name}`))?.[0];

                        if (!spaceDb) {
                            spaceDb = (await dbTx.insert(spaces).values({ name: name, status: 'pre-auction' }).returning())?.[0];
                            newSpaceStatus = 'pre-auction';
                        }

                        let spacesHistoryDb = await dbTx.select().from(spacesHistory).where(sql`${spacesHistory.spaceId} = ${spaceDb.id}`).orderBy(spacesHistory.id);

                        let action = null;
                        let bid_amount = null;

                        if (meta.bid_value != null) {
                            action = 'rollout';
                            newSpaceStatus = 'auction';
                        } else if (spacesHistoryDb.length > 0 && spacesHistoryDb[spacesHistoryDb.length - 1].action === 'bid' && meta.covenant?.type === 'transfer') {
                            action = 'register';
                            newSpaceStatus = 'registered'
                        } else if (meta.covenant?.type === 'bid') {
                            action = 'bid';
                            bid_amount = meta.covenant.total_burned;
                        } else if (meta.action != null){
                            if (meta.action === 'revoke')
                                newSpaceStatus = 'revoked';
                            action = meta.action;
                        }

                        const historyRecord = (await dbTx.insert(spacesHistory).values({
                            spaceName: spaceDb.name,
                            spaceId: spaceDb.id,
                            transactionId: transactionsDb.find(x => x.txid === tx.txid).id,
                            txid: tx.txid,
                            action,
                            bid_amount,
                            meta
                        }).returning())?.[0];

                        if (newSpaceStatus) {
                            await dbTx.update(spaces).set({ status: newSpaceStatus, spacesHistoryId: historyRecord.id, updatedAt: sql`now()` }).where(sql`${spaces.id} = ${spaceDb.id}`);
                        }
                    }
                }
            });
        } catch (e) {
            console.error(e);
            throw e;
        }
    }
}

export default SimpleIndexer;

async function sync() {
    const LOCK_KEY = 123456;
    let startBlockHeight = null;
    let endBlockHeight = null;
    let startTime = null;
    let db = await getDb();

    try {
        const db_lock = await db.execute(sql`SELECT pg_try_advisory_lock(${LOCK_KEY})`);

        if (!db_lock.rows[0].pg_try_advisory_lock) {
            console.log(`Another instance is running. Exiting.`);
            return;
        }

        console.log(`Starting sync ...`);

        startTime = performance.now();

        const last_sync = (await db.select().from(syncs).orderBy(desc(syncs.endBlockHeight)).limit(1))?.[0];
        let height = last_sync?.endBlockHeight ? (last_sync.endBlockHeight + 1) : 2865460; // 2865460 is the block height at which the spaces protocol was activated on testnet. You may change this to 0 if using regtest.
        startBlockHeight = height;

        const bitcoinClient = new SimpleRpcClient('http://localhost:18332', 'test', 'test');
        const spacedClient = new SimpleRpcClient('http://localhost:22221');
        const simpleIndexer = new SimpleIndexer();
        const blockCount = await bitcoinClient.request('getblockcount');

        if (blockCount < height) {
            console.log('No new blocks to process.');
            return;
        }


        while (height <= blockCount) {
            const blockHash = await bitcoinClient.request('getblockhash', [height]);

            // You can fetch the whole block from bitcoin core
            const block = await bitcoinClient.request('getblock', [blockHash]);

            // Spaced indexes transactions relevant to the spaces protocol by the block hash
            // if a block does not have any spaces transactions, it will not be stored in the index
            const txData = (await spacedClient.request('getblockdata', [blockHash]))?.tx_data ?? [];

            await simpleIndexer.processBlock(block, txData, db);
            endBlockHeight = height;
            height++;
        }
    } catch (error) {
        console.error(error);
    } finally {
        if (startBlockHeight != null && endBlockHeight != null) {
            await db.insert(syncs).values({
                startBlockHeight,
                endBlockHeight,
                durationSeconds: Math.round((performance.now() - startTime) / 1000),
            });

            console.log(`Synced blocks from ${startBlockHeight} to ${endBlockHeight}. Duration: ${Math.round((performance.now() - startTime) / 1000)} seconds.`);
        }

        await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_KEY})`);
        db.end();
    }
}


console.log('scheduling syncs');
// cron.schedule('* * * * *', async () => {
//     console.log('Cron: starting sync...');
//     await sync().catch(console.error);
// });

sync().catch(console.error);