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
export const ViewsApi = HttpApiGroup.make('views')
  .add(
    HttpApiEndpoint.get('listWorkItemViews', '/work-item-views')
      .addSuccess(Schema.Struct({ items: Schema.Array(WorkItemView) }))
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
