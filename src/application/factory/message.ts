import { Schema } from 'effect';

const PositiveInt = Schema.Int.pipe(Schema.positive());

export const RunFactoryMessage = Schema.Struct({
  kind: Schema.Literal('run_factory'),
  factoryRunId: PositiveInt,
  stageRunId: PositiveInt,
});
export type RunFactoryMessage = typeof RunFactoryMessage.Type;

export const parseRunFactoryMessage = Schema.decodeUnknownSync(RunFactoryMessage);
