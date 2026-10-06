import { withTx } from "../lib/db";

class DryRunAbort extends Error {}

export interface ImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  warnings: string[];
  columns: { recognized: Record<string, string | undefined>; ignored: string[] };
}

/** Runs the real import inside a transaction; a dry run rolls it back so the preview is exact. */
export async function runImport(dryRun: boolean, work: (tx: import("pg").PoolClient) => Promise<ImportResult>): Promise<ImportResult> {
  let result: ImportResult | undefined;
  try {
    await withTx(async (tx) => {
      result = await work(tx);
      if (dryRun) throw new DryRunAbort();
    });
  } catch (err) {
    if (!(err instanceof DryRunAbort)) throw err;
  }
  return { ...result!, dryRun };
}
