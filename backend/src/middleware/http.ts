import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

declare module 'express-serve-static-core' {
  interface Request { requestId: string }
}

export const requestId: RequestHandler = (req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

export const notFound: RequestHandler = (_req, _res, next) => next(new AppError('NOT_FOUND', 'Resource not found.'));

/** Consistent error shape; internals and stack traces are never sent to clients. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;
  if (err instanceof AppError) appErr = err;
  else if (err instanceof z.ZodError) appErr = new AppError('VALIDATION_FAILED', 'Request validation failed.', z.flattenError(err));
  else if (err?.code === '23505') appErr = new AppError('CONFLICT', 'A record with these details already exists.');
  else if (err?.code === '23514') appErr = new AppError('VALIDATION_FAILED', 'One or more values are out of the allowed range.');
  else if (err?.code === '23503') appErr = new AppError('BAD_REQUEST', 'A referenced record does not exist.');
  else if (err?.type === 'entity.too.large') appErr = new AppError('PAYLOAD_TOO_LARGE', 'The request body is too large.');
  else if (err?.type === 'entity.parse.failed') appErr = new AppError('BAD_REQUEST', 'Malformed JSON body.');
  else {
    logger.error({ err: { message: err?.message, name: err?.name }, requestId: req.requestId }, 'unhandled error');
    appErr = new AppError('INTERNAL', 'An unexpected error occurred.');
  }
  res.status(appErr.status).json({
    error: { code: appErr.code, message: appErr.message, requestId: req.requestId, ...(appErr.details ? { details: appErr.details } : {}) },
  });
};

/** Reads a path parameter that `validate({ params })` has already checked. */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string') throw new AppError('BAD_REQUEST', `Missing path parameter ${name}.`);
  return v;
}

/** Validate and replace body/query/params with parsed values. */
export const validate = (schemas: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType }): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.params) schemas.params.parse(req.params);
      if (schemas.query) schemas.query.parse(req.query);
      next();
    } catch (e) { next(e); }
  };
