import { isJsonObject, isNumber, isString, parseJson, type JsonValue } from '../../shared/json.ts';

export interface AiGatewayLogUsage {
  logId: string;
  organizationId: string;
  agentRunId: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface AiGatewayLogsConfig {
  accountId: string;
  gatewayId: string;
  apiToken: string;
}

function nonNegativeNumber(value: JsonValue, name: string): number {
  if (!isNumber(value) || !Number.isFinite(value) || value < 0) {
    throw new Error(`AI Gateway log has invalid ${name}`);
  }
  return value;
}

export async function getAiGatewayLogUsage(
  config: AiGatewayLogsConfig,
  input: { logId: string; organizationId: string; agentRunId: number },
  fetchUpstream: typeof fetch = fetch,
): Promise<AiGatewayLogUsage | null> {
  const response = await fetchUpstream(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}` +
      `/ai-gateway/gateways/${encodeURIComponent(config.gatewayId)}/logs/${encodeURIComponent(input.logId)}`,
    { headers: { authorization: `Bearer ${config.apiToken}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`AI Gateway log lookup failed with ${response.status}`);

  const payload = parseJson(await response.text());
  if (!isJsonObject(payload) || payload.success !== true || !isJsonObject(payload.result)) {
    throw new Error('AI Gateway log lookup returned an invalid envelope');
  }
  const result = payload.result;
  if (!isString(result.id) || result.id !== input.logId) {
    throw new Error('AI Gateway log lookup returned the wrong log');
  }
  if (!isString(result.metadata)) throw new Error('AI Gateway log is missing attribution');
  const metadata = parseJson(result.metadata);
  const attributedAgentRun = isJsonObject(metadata) ? metadata.agent_run_id : null;
  const agentRunMatches =
    (isNumber(attributedAgentRun) && attributedAgentRun === input.agentRunId) ||
    (isString(attributedAgentRun) && attributedAgentRun === `${input.agentRunId}`);
  if (
    !isJsonObject(metadata) ||
    metadata.organization_id !== input.organizationId ||
    !agentRunMatches
  ) {
    throw new Error('AI Gateway log attribution does not match the agent run');
  }
  if (!isNumber(result.cost)) return null;

  return {
    logId: result.id,
    organizationId: input.organizationId,
    agentRunId: input.agentRunId,
    tokensIn: nonNegativeNumber(result.tokens_in, 'tokens_in'),
    tokensOut: nonNegativeNumber(result.tokens_out, 'tokens_out'),
    costUsd: nonNegativeNumber(result.cost, 'cost'),
  };
}
