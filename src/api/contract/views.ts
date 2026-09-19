import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import { Artifact } from './artifacts.ts';
import { Change } from './changes.ts';
import { Delivery } from './deliveries.ts';
import { FactoryRun } from './executions.ts';
import { WorkItem } from './work-items.ts';
import { DomainError } from './errors.ts';

const id = (name: string) =>
  HttpApiSchema.param(name, Schema.NumberFromString.pipe(Schema.int(), Schema.positive()));
export const WorkItemView = Schema.Struct({
  workItem: WorkItem,
  deliveries: Schema.Array(Delivery),
  plan: Schema.NullOr(Artifact),
  factoryRuns: Schema.Array(FactoryRun),
  defaultModel: Schema.String,
});
export type WorkItemView = typeof WorkItemView.Type;
export const DeliveryView = Schema.Struct({
  delivery: Delivery,
  workItem: WorkItem,
  change: Schema.NullOr(Change),
  revision: Schema.NullOr(Artifact),
  plan: Schema.NullOr(Artifact),
  factoryRuns: Schema.Array(FactoryRun),
});
export type DeliveryView = typeof DeliveryView.Type;
const PositiveInt = Schema.Int.pipe(Schema.positive());
const BoardCursor = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[1-9]\d*$/),
  Schema.filter((value) => {
    const [date, id] = value.split('|');
    const timestamp = Date.parse(date!);
    return (
      Number.isFinite(timestamp) &&
      Number(date!.slice(0, 4)) > 0 &&
      new Date(timestamp).toISOString().slice(0, 19) === date!.slice(0, 19) &&
      Number.isSafeInteger(Number(id))
    );
  }),
);
export const BoardCursors = Schema.Struct({
  activeBefore: Schema.optional(BoardCursor),
  historyBefore: Schema.optional(BoardCursor),
});
export const BoardView = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      organizationId: Schema.String,
      title: Schema.String,
      notes: Schema.NullOr(Schema.String),
      status: Schema.Literal(
        'open',
        'planning',
        'awaiting_approval',
        'approved',
        'in_progress',
        'completed',
        'cancelled',
      ),
      column: Schema.Literal('in_progress', 'done'),
      createdAt: Schema.String,
      targets: Schema.Array(
        Schema.Struct({
          repositoryId: PositiveInt,
          owner: Schema.String,
          name: Schema.String,
          provider: Schema.String,
          deliveryId: Schema.NullOr(PositiveInt),
          deliveryStatus: Schema.NullOr(Schema.String),
          changeNumber: Schema.NullOr(PositiveInt),
          changeStatus: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
  activeNextBefore: Schema.NullOr(BoardCursor),
  historyNextBefore: Schema.NullOr(BoardCursor),
});
export type BoardView = typeof BoardView.Type;
export const ViewsApi = HttpApiGroup.make('views')
  .add(
    HttpApiEndpoint.get('getBoardView', '/board-view')
      .setUrlParams(BoardCursors)
      .addSuccess(BoardView)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getWorkItemView')`/work-items/${id('workItemId')}/view`
      .addSuccess(WorkItemView)
      .addError(DomainError),
  )
  .add(
    HttpApiEndpoint.get('getDeliveryView')`/deliveries/${id('deliveryId')}/view`
      .addSuccess(DeliveryView)
      .addError(DomainError),
  );
