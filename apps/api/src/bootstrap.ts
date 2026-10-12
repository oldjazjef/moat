import 'reflect-metadata';

import type { AddressInfo } from 'node:net';
import {
  type INestApplication,
  type LoggerService,
  type LogLevel,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app/app.module';
import { LOCAL_HOST } from './config/env';
import {
  DESKTOP_ACCESS_HEADER,
  requireAccessToken,
  requireHost,
} from './security/access';

export const GLOBAL_PREFIX = 'api';
export { DESKTOP_ACCESS_HEADER };

/** What the desktop shell passes (as lazy-koins: the API runs in the Electron main process). */
export interface BootstrapOptions {
  /** `0` = a free port chosen by the OS. */
  port: number;
  /**
   * Every request must carry this value in `x-moat-desktop`, or it gets a 403. Required: without
   * it, `AUTH_MODE=local` would serve any program on this machine.
   */
  accessToken: string;
  /**
   * Register Nest's SIGTERM/SIGINT hooks (default `false`). The desktop shell closes the API
   * itself on quit; Nest's hooks would re-raise the signal and kill Electron's main process.
   */
  shutdownHooks?: boolean;
  /** Nest logger setting (default: Nest's console logger). */
  logger?: LoggerService | LogLevel[] | false;
}

export interface RunningApi {
  app: INestApplication;
  /** The port actually bound (the OS's choice when `port: 0`). */
  port: number;
  /** Always 127.0.0.1. */
  host: string;
}

/** Creates, configures and starts the API on 127.0.0.1. */
export async function bootstrap(
  options: BootstrapOptions,
): Promise<RunningApi> {
  if (options.accessToken.length < 32) {
    throw new Error('The desktop access token must be at least 32 characters');
  }
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    options.logger === undefined ? {} : { logger: options.logger },
  );
  // Express would answer `X-Powered-By: Express` and honour X-Forwarded-* otherwise.
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  express.set('trust proxy', false);

  // DT-16 first (a rebinding page never reaches anything else), then the per-launch token.
  let host = '';
  app.use(requireHost(() => host));
  app.use(requireAccessToken(options.accessToken));
  app.use(helmet());
  app.setGlobalPrefix(GLOBAL_PREFIX);
  if (options.shutdownHooks === true) app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // No CORS: the window talks to the API through the app:// proxy, never cross-origin.

  // AUTH_MODE=local trusts its caller, so it must never be reachable from another machine.
  await app.listen(options.port, LOCAL_HOST);
  const address = app.getHttpServer().address() as AddressInfo;
  host = `${LOCAL_HOST}:${address.port}`;
  return { app, port: address.port, host: address.address };
}
