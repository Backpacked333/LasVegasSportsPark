import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './kernel/app-setup';
import { loadConfig } from './kernel/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot({ config }), {
    logger: [config.LOG_LEVEL],
  });
  configureApp(app, config);
  await app.listen(config.PORT);
  new Logger('Bootstrap').log(`Sportspark API listening on :${config.PORT} (${config.NODE_ENV})`);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
