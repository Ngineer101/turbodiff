import { isJsonObject, isString, parseJson } from '../shared/json.ts';

export function requestUsesGrantedModel(body: string, grantedModel: string): boolean {
  try {
    const parsed = parseJson(body);
    return isJsonObject(parsed) && isString(parsed.model) && parsed.model === grantedModel;
  } catch {
    return false;
  }
}
