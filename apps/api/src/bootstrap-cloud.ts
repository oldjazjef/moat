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
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { CloudAppModule } from './cloud/cloud-app.module';
import { requireSameOrigin } from './cloud/auth/auth.http';
import type { Env } from './config/env';

export const CLOUD_GLOBAL_PREFIX = 'api';

export interface CloudBootstrapOptions {
  /** `0` = a free port chosen by the OS. */
  port: number;
  /** The interface to bind (default 127.0.0.1; a container passes 0.0.0.0). */
  host?: string;
  shutdownHooks?: boolean;
  logger?: LoggerService | LogLevel[] | false;
}

export interface RunningCloud {
  app: INestApplication;
  port: number;
}

/**
 * Creates and starts the Cloud API (`AUTH_MODE=cloud`, environment validated by the module at
 * import). Not wired into a server entry or image yet: this slice delivers the accounts and tenant
 * foundation as a library, exercised by its specs and the authz matrix.
 */
export async function bootstrapCloud(
  options: CloudBootstrapOptions,
): Promise<RunningCloud> {
  const app = await NestFactory.create<NestExpressApplication>(
    CloudAppModule,
    options.logger === undefined ? {} : { logger: options.logger },
  );
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  // `request.ip` (rate limits) is the socket address unless a number of proxies is configured.
  const proxies = Number(config.get('MOAT_TRUST_PROXY', { infer: true }));
  express.set('trust proxy', proxies === 0 ? false : proxies);

  app.use(helmet());
  // Nothing of an account or a tenant may sit in a shared cache or the browser history.
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  // No CORS: the dashboard is served from the same origin. Cross-site writes are refused (T-78).
  app.use(requireSameOrigin(config.get('MOAT_PUBLIC_ORIGIN', { infer: true })));
  app.setGlobalPrefix(CLOUD_GLOBAL_PREFIX);
  if (options.shutdownHooks === true) app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(options.port, options.host ?? '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, port: address.port };
}
