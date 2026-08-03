// Minimal ambient types for `pg` (devDependency without bundled types; @types/pg not
// installed). Only what scripts/migrate-from-postgres.ts uses.
declare module "pg" {
  export interface QueryResult {
    rows: any[];
  }
  export class Client {
    constructor(config?: { connectionString?: string });
    connect(): Promise<void>;
    query(sql: string): Promise<QueryResult>;
    end(): Promise<void>;
  }
  export const types: {
    setTypeParser(oid: number, parser: (value: string) => unknown): void;
  };
  const pg: { Client: typeof Client; types: typeof types };
  export default pg;
}
