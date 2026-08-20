// Safe connection metadata that may cross service and agent boundaries.
// Authentication material stays in the data layer and is resolved server-side.
export interface ConnectionSnapshot {
  id: number;
  name: string;
  url: string;
  tools?: string[];
  hasAuth: boolean;
  authType: string;
  optional: boolean;
}
