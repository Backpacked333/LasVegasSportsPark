/**
 * Vercel function entry: the whole API as one Node function, for the protected staging host
 * (hosting DEC-021 pending; see docs/deploy/staging.md). It boots the same application as
 * `src/main.ts` once per instance and hands every request to its Express adapter.
 *
 * With STAGING_INLINE_WORKER=true the instance also runs the durable worker's loops (outbox
 * dispatch, inbox, background workers, idempotency sweep) while it is warm, because a function
 * host has no separate worker process. Production runs `dist/worker.js` as its own process.
 */
'use strict';
/* global console, setInterval */
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { configureApp } = require('../dist/kernel/app-setup');
const { loadConfig } = require('../dist/kernel/config');
const { createLogger } = require('../dist/kernel/logging/json-logger');
const { Inbox } = require('../dist/kernel/inbox/inbox');
const { OutboxDispatcher } = require('../dist/kernel/outbox/outbox-dispatcher');
const { BackgroundWorkers } = require('../dist/kernel/workers/background-workers');
const { IdempotencySweeper } = require('../dist/kernel/http/idempotency-sweeper');

let ready = null;

function startInlineWorker(app, config) {
  app.get(OutboxDispatcher).start();
  app.get(BackgroundWorkers).startAll();
  const inbox = app.get(Inbox);
  const sweeper = app.get(IdempotencySweeper);
  let inboxRun = null;
  let sweepRun = null;
  const log = (what) => (error) => console.error(`${what} failed: ${String(error)}`);
  setInterval(() => {
    if (inboxRun) return;
    inboxRun = inbox
      .runOnce(config.OUTBOX_BATCH_SIZE, { shouldStop: () => false })
      .catch(log('inbox processing'))
      .finally(() => (inboxRun = null));
  }, config.OUTBOX_POLL_INTERVAL_MS).unref();
  setInterval(() => {
    if (sweepRun) return;
    sweepRun = sweeper
      .sweep()
      .catch(log('idempotency sweep'))
      .finally(() => (sweepRun = null));
  }, config.IDEMPOTENCY_SWEEP_INTERVAL_MS).unref();
}

async function boot() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot({ config }), {
    logger: createLogger(config, 'api'),
  });
  configureApp(app, config);
  await app.init();
  if (process.env.STAGING_INLINE_WORKER === 'true') startInlineWorker(app, config);
  return app.getHttpAdapter().getInstance();
}

module.exports = async function handler(req, res) {
  if (!ready) {
    ready = boot().catch((error) => {
      ready = null;
      throw error;
    });
  }
  const express = await ready;
  express(req, res);
};
