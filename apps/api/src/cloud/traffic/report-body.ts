import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { MAX_REPORT_BYTES } from '@moat/core';

/**
 * The body of `POST /api/report/:token` as raw bytes, whatever the Content-Type says, at most
 * MAX_REPORT_BYTES: the report is read strictly from what the gate sent (T-110). A larger body is
 * a 413 in the API's JSON shape, never Express's HTML page.
 */
export function reportBodyParser() {
  const raw = express.raw({ type: () => true, limit: MAX_REPORT_BYTES });
  return (request: Request, response: Response, next: NextFunction): void => {
    raw(request, response, (error?: unknown) => {
      if (error === undefined || error === null) {
        next();
        return;
      }
      const status = (error as { status?: unknown }).status === 413 ? 413 : 400;
      response.status(status).json({
        statusCode: status,
        error: status === 413 ? 'too_large' : 'body_invalid',
      });
    });
  };
}
