/**
 * Middleware service for handling emitted events on chronobank platform
 * @module Chronobank/waves-blockprocessor
 *
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Kirill Sergeev <cloudkserg11@gmail.com>
 */
const mongoose = require('mongoose'),
  config = require('./config'),
  Promise = require('bluebird'),
  MasterNodeService = require('middleware-common-components/services/blockProcessor/MasterNodeService'),
  models = require('./models'),
  _ = require('lodash'),
  providerService = require('./services/providerService'),
  BlockWatchingService = require('./services/blockWatchingService'),
  SyncCacheService = require('./services/syncCacheService'),
  AmqpService = require('middleware_common_infrastructure/AmqpService'),
  InfrastructureInfo = require('middleware_common_infrastructure/InfrastructureInfo'),
  InfrastructureService = require('middleware_common_infrastructure/InfrastructureService'),
  filterTxsByAccountService = require('./services/filterTxsByAccountService'),
  amqp = require('amqplib'),
  bunyan = require('bunyan'),
  log = bunyan.createLogger({name: 'core.blockProcessor', level: config.logs.level});


mongoose.Promise = Promise;
mongoose.connect(config.mongo.data.uri, {useMongoClient: true});
mongoose.accounts = mongoose.createConnection(config.mongo.accounts.uri, {useMongoClient: true});

const runSystem = async function () {
  const rabbit = new AmqpService(
    config.systemRabbit.url, 
    config.systemRabbit.exchange,
    config.systemRabbit.serviceName
  );
  const info = new InfrastructureInfo(require('./package.json'));
  const system = new InfrastructureService(info, rabbit, {checkInterval: 10000});
  await system.start();
  system.on(system.REQUIREMENT_ERROR, (requirement, version) => {
    log.error(`Not found requirement with name ${requirement.name} version=${requirement.version}.` +
        ` Last version of this middleware=${version}`);
    process.exit(1);
  });
  await system.checkRequirements();
  system.periodicallyCheck();
};

const init = async function () {
  if (config.checkSystem)
    await runSystem();

  [mongoose.accounts, mongoose.connection].forEach(connection =>
    connection.on('disconnected', () => {
      throw new Error('mongo disconnected!');
    })
  );

  models.init();

  let amqpInstance = await amqp.connect(config.rabbit.url);

  let channel = await amqpInstance.createChannel();

  channel.on('close', () => {
    throw new Error('rabbitmq process has finished!');
  });

  await channel.assertExchange('events', 'topic', {durable: false});
  await channel.assertExchange('internal', 'topic', {durable: false});
  await channel.assertQueue(`${config.rabbit.serviceName}_current_provider.get`, {durable: false, autoDelete: true});
  await channel.bindQueue(`${config.rabbit.serviceName}_current_provider.get`, 'internal', `${config.rabbit.serviceName}_current_provider.get`);



  const masterNodeService = new MasterNodeService(channel, config.rabbit.serviceName);
  await masterNodeService.start();

  providerService.on('provider_set', providerURI => {
    let providerIndex = _.findIndex(config.node.providers, providerURI);
    if (providerIndex !== -1)
      channel.publish('internal', `${config.rabbit.serviceName}_current_provider.set`, new Buffer(JSON.stringify({index: providerIndex})));
  });

  channel.consume(`${config.rabbit.serviceName}_current_provider.get`, async () => {
    let providerInstance = await providerService.get();
    let providerIndex = _.findIndex(config.node.providers, provider => provider.http === providerInstance.http);
    if (providerIndex !== -1)
      channel.publish('internal', `${config.rabbit.serviceName}_current_provider.set`, new Buffer(JSON.stringify({index: providerIndex})));
  }, {noAck: true});


  const syncCacheService = new SyncCacheService();


  let blockEventCallback = async block => {
    log.info(`${block.signature} (${block.number}) added to cache.`);
    let filtered = await filterTxsByAccountService(block.transactions);
    await Promise.all(filtered.map(item => {
      channel.publish('events', `${config.rabbit.serviceName}_transaction.${item.address}`, new Buffer(JSON.stringify(Object.assign(item))));
    }));
  };

  let txEventCallback = async tx => {
    let filtered = await filterTxsByAccountService([tx]);
    await Promise.all(filtered.map(item => {
      channel.publish('events', `${config.rabbit.serviceName}_transaction.${item.address}`, new Buffer(JSON.stringify(Object.assign(item))));
    }));
  };

  syncCacheService.on('block', blockEventCallback);


  let endBlock = await syncCacheService.start();

  await new Promise(res => {
    if (config.sync.shadow)
      return res();

    syncCacheService.on('end', () => {
      log.info(`cached the whole blockchain up to block: ${endBlock}`);
      res();
    });
  });

  const blockWatchingService = new BlockWatchingService(endBlock);

  blockWatchingService.on('block', blockEventCallback);
  blockWatchingService.on('tx', txEventCallback);

  await blockWatchingService.startSync(endBlock);
};

module.exports = init().catch(err => {
  log.error(err);
  process.exit(0);
});
