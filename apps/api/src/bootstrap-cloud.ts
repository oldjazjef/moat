import 'reflect-metadata';

import type { Server } from 'node:http';
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
import { probes } from './cloud-server/probes';
import {
  cloudHelmetOptions,
  PERMISSIONS_POLICY,
} from './cloud-server/security-headers';
import { createStaticSite } from './cloud-server/static-site';
import type { Env } from './config/env';
import { CloudDatabase } from './persistence/cloud/cloud-database';

export const CLOUD_GLOBAL_PREFIX = 'api';

export interface CloudBootstrapOptions {
  /** `0` = a free port chosen by the OS. */
  port: number;
  /** The interface to bind (default 127.0.0.1; a container passes 0.0.0.0). */
  host?: string;
  shutdownHooks?: boolean;
  /**
   * The dashboard's build folder (`web:build:cloud`, `…/browser`): served from the same origin
   * (cloud-server/static-site.ts). Absent = API only (development behind the Angular dev server,
   * specs).
   */
  webDir?: string;
  logger?: LoggerService | LogLevel[] | false;
}

export interface RunningCloud {
  app: INestApplication;
  port: number;
  /** `/readyz` answers 503 from now on, then the server stops accepting and closes (graceful). */
  shutdown(): Promise<void>;
}

/** Idle connections are closed at once, running requests get this long (ms). */
const DRAIN_GRACE_MS = 10_000;

/**
 * Creates and starts the Cloud server (`AUTH_MODE=cloud`, environment validated by the module at
 * import): the API under `/api`, `/healthz` and `/readyz`, and with `webDir` the dashboard from the
 * same origin. The entry is `main-cloud.ts`.
 */
export async function bootstrapCloud(
  options: CloudBootstrapOptions,
): Promise<RunningCloud> {
  const app = await NestFactory.create<NestExpressApplication>(
    CloudAppModule,
    options.logger === undefined ? {} : { logger: options.logger },
  );
  let draining = false;
  try {
    const config = app.get<ConfigService<Env, true>>(ConfigService);
    const express = app.getHttpAdapter().getInstance();
    express.disable('x-powered-by');
    // `request.ip` (rate limits) is the socket address unless a number of proxies is configured.
    const proxies = Number(config.get('MOAT_TRUST_PROXY', { infer: true }));
    express.set('trust proxy', proxies === 0 ? false : proxies);

    const secure = config.get('MOAT_COOKIE_SECURE', { infer: true }) === 'true';
    app.use(helmet(cloudHelmetOptions(secure)));
    app.use((_request: Request, response: Response, next: NextFunction) => {
      response.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
      next();
    });
    const database = app.get(CloudDatabase);
    app.use(
      probes({
        draining: () => draining,
        ready: async () => {
          await database.client.$queryRaw`SELECT 1`;
          return true;
        },
      }),
    );
    // Nothing of an account or a tenant may sit in a shared cache or the browser history.
    app.use((_request: Request, response: Response, next: NextFunction) => {
      response.setHeader('Cache-Control', 'no-store');
      next();
    });
    // No CORS: the dashboard is served from the same origin. Cross-site writes are refused (T-78).
    app.use(
      requireSameOrigin(config.get('MOAT_PUBLIC_ORIGIN', { infer: true })),
    );
    if (options.webDir !== undefined) app.use(createStaticSite(options.webDir));
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
  } catch (error) {
    // A refused start (no dashboard folder, port in use) must not leave the database open.
    await app.close().catch(() => undefined);
    throw error;
  }
  const server = app.getHttpServer() as Server;
  const address = server.address() as AddressInfo;
  return {
    app,
    port: address.port,
    async shutdown() {
      draining = true;
      server.closeIdleConnections();
      const closing = app.close();
      const timer = setTimeout(
        () => server.closeAllConnections(),
        DRAIN_GRACE_MS,
      );
      try {
        await closing;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
