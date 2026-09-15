import { HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';

const BAD_REQUEST_TYPE = 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.1' as const;
const UNAUTHORIZED_TYPE = 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.2' as const;
const FORBIDDEN_TYPE = 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4' as const;
const NOT_FOUND_TYPE = 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.5' as const;
const CONFLICT_TYPE = 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.10' as const;
const INTERNAL_SERVER_ERROR_TYPE =
  'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.1' as const;
const BAD_GATEWAY_TYPE = 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.3' as const;
const SERVICE_UNAVAILABLE_TYPE =
  'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.4' as const;

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  'BadRequest',
  {
    type: Schema.Literal(BAD_REQUEST_TYPE),
    title: Schema.Literal('Bad Request'),
    status: Schema.Literal(400),
    detail: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  {
    type: Schema.Literal(UNAUTHORIZED_TYPE),
    title: Schema.Literal('Unauthorized'),
    status: Schema.Literal(401),
    detail: Schema.String,
  },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  'Forbidden',
  {
    type: Schema.Literal(FORBIDDEN_TYPE),
    title: Schema.Literal('Forbidden'),
    status: Schema.Literal(403),
    detail: Schema.String,
  },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  'NotFound',
  {
    type: Schema.Literal(NOT_FOUND_TYPE),
    title: Schema.Literal('Not Found'),
    status: Schema.Literal(404),
    detail: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  'Conflict',
  {
    type: Schema.Literal(CONFLICT_TYPE),
    title: Schema.Literal('Conflict'),
    status: Schema.Literal(409),
    detail: Schema.String,
  },
  HttpApiSchema.annotations({ status: 409 }),
) {}

export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  'ServiceUnavailable',
  {
    type: Schema.Literal(SERVICE_UNAVAILABLE_TYPE),
    title: Schema.Literal('Service Unavailable'),
    status: Schema.Literal(503),
    detail: Schema.String,
  },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class UpstreamFailure extends Schema.TaggedError<UpstreamFailure>()(
  'UpstreamFailure',
  {
    type: Schema.Literal(BAD_GATEWAY_TYPE),
    title: Schema.Literal('Bad Gateway'),
    status: Schema.Literal(502),
    detail: Schema.String,
  },
  HttpApiSchema.annotations({ status: 502 }),
) {}

export class InternalServerError extends Schema.TaggedError<InternalServerError>()(
  'InternalServerError',
  {
    type: Schema.Literal(INTERNAL_SERVER_ERROR_TYPE),
    title: Schema.Literal('Internal Server Error'),
    status: Schema.Literal(500),
    detail: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export const badRequest = (detail: string) =>
  new BadRequest({
    type: BAD_REQUEST_TYPE,
    title: 'Bad Request',
    status: 400,
    detail,
  });

export const unauthorized = (detail = 'A valid session is required') =>
  new Unauthorized({
    type: UNAUTHORIZED_TYPE,
    title: 'Unauthorized',
    status: 401,
    detail,
  });

export const forbidden = (detail: string) =>
  new Forbidden({
    type: FORBIDDEN_TYPE,
    title: 'Forbidden',
    status: 403,
    detail,
  });

export const notFound = (detail: string) =>
  new NotFound({
    type: NOT_FOUND_TYPE,
    title: 'Not Found',
    status: 404,
    detail,
  });

export const conflict = (detail: string) =>
  new Conflict({
    type: CONFLICT_TYPE,
    title: 'Conflict',
    status: 409,
    detail,
  });

export const serviceUnavailable = (detail: string) =>
  new ServiceUnavailable({
    type: SERVICE_UNAVAILABLE_TYPE,
    title: 'Service Unavailable',
    status: 503,
    detail,
  });

export const upstreamFailure = (detail: string) =>
  new UpstreamFailure({
    type: BAD_GATEWAY_TYPE,
    title: 'Bad Gateway',
    status: 502,
    detail,
  });

export const internalServerError = () =>
  new InternalServerError({
    type: INTERNAL_SERVER_ERROR_TYPE,
    title: 'Internal Server Error',
    status: 500,
    detail: 'The request could not be completed',
  });

export const DomainError = Schema.Union(
  BadRequest,
  Forbidden,
  NotFound,
  Conflict,
  ServiceUnavailable,
  UpstreamFailure,
  InternalServerError,
);

export type DomainError = typeof DomainError.Type;
