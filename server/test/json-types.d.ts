// @types/bun types Response.json() as unknown; tests treat it as any.
declare global {
  interface Response {
    json(): Promise<any>;
  }
}
export {};
