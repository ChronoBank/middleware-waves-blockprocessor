/** 
* Copyright 2017–2018, LaborX PTY
* Licensed under the AGPL Version 3 license.
* @author Kirill Sergeev <cloudkserg11@gmail.com>
*/
const bunyan = require('bunyan'),
  _ = require('lodash'),
  Promise = require('bluebird'),
  models = require('../models'),
  getBlock = require('../utils/blocks/getBlock'),
  addBlock = require('../utils/blocks/addBlock'),
  EventEmitter = require('events'),
  syncCacheServiceInterface = require('middleware-common-components/interfaces/blockProcessor/syncCacheServiceInterface'),
  providerService = require('../services/providerService'),
  allocateBlockBuckets = require('../utils/blocks/allocateBlockBuckets'),
  log = bunyan.createLogger({name: 'shared.services.syncCacheService'});

/**
 * @service
 * @description sync the blockchain history
 * @returns {Promise.<*>}
 */

class SyncCacheService {

  constructor () {
    this.events = new EventEmitter();
  }

  /** @function
   * @description start syncing process
   * @return {Promise<*>}
   */
  async start () {
    await this.indexCollection();
    let data = await allocateBlockBuckets();
    this.doJob(data.missedBuckets);
    return data.height;
  }

  /**
   * @function
   * @description index all collections in mongo
   * @return {Promise<void>}
   */
  async indexCollection () {
    log.info('indexing...');
    await models.blockModel.init();
    await models.accountModel.init();
    await models.txModel.init();
    log.info('indexation completed!');
  }

  /**
   * @function
   * @description process the buckets
   * @param buckets - array of blocks
   * @return {Promise<void>}
   */
  async doJob (buckets) {

    while (buckets.length)
      try {
        for (let bucket of buckets) {
          await this.runPeer(bucket);
          if (!bucket.length)
            _.pull(buckets, bucket);
        }

        this.events.emit('end');

      } catch (err) {
        log.error(err);
      }
  }

  /**
   * @function
   * @description process the bucket
   * @param bucket
   * @return {Promise<*>}
   */
  async runPeer (bucket) {

    let apiProvider = await providerService.get();
    let lastBlock = await apiProvider.getBlockByNumber(_.last(bucket));

    if (!lastBlock || (_.last(bucket) !== 0 && !lastBlock.number))
      return await Promise.delay(10000);

    log.info(`nem provider took chuck of blocks ${bucket[0]} - ${_.last(bucket)}`);

    let blocksToProcess = [];
    for (let blockNumber = _.last(bucket); blockNumber >= bucket[0]; blockNumber--)
      blocksToProcess.push(blockNumber);

    await Promise.mapSeries(blocksToProcess, async (blockNumber) => {
      let block = await getBlock(blockNumber);
      await addBlock(block);
      _.pull(bucket, blockNumber);
      this.events.emit('block', block);
    });
  }
}

module.exports = function (...args) {
  return syncCacheServiceInterface(new SyncCacheService(...args));
};