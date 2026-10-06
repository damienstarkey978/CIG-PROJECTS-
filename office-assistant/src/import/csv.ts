import { parse } from "csv-parse/sync";

/** Lowercases and collapses punctuation so "Job Name", "job_name" and "JOB-NAME" all match. */
export function normHeader(h: string): string {
  return h.replace(/^﻿/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  // Excel and Buildertrend exports are sometimes semicolon or tab separated.
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", "\t", ";"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const records: string[][] = parse(text, { delimiter, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
  if (records.length < 2) throw new Error("The file needs a header row and at least one data row");
  const headers = records[0].map(normHeader);
  const rows = records.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { headers, rows };
}

/** Finds which file column feeds each of our fields, and which columns were ignored. */
export function mapColumns<F extends string>(headers: string[], synonyms: Record<F, string[]>) {
  const map = {} as Record<F, string | undefined>;
  const used = new Set<string>();
  for (const [field, names] of Object.entries(synonyms) as [F, string[]][]) {
    const hit = names.find((n) => headers.includes(n));
    map[field] = hit;
    if (hit) used.add(hit);
  }
  return { map, ignored: headers.filter((h) => !used.has(h) && h) };
}

export function pick<F extends string>(row: Record<string, string>, map: Record<F, string | undefined>, field: F): string {
  const col = map[field];
  return col ? (row[col] ?? "").trim() : "";
}

export function splitName(raw: string): { first: string | null; last: string | null } {
  const s = raw.trim();
  if (!s) return { first: null, last: null };
  if (s.includes(",")) {
    const [last, first] = s.split(",", 2).map((x) => x.trim());
    return { first: first || null, last: last || null };
  }
  const [first, ...rest] = s.split(/\s+/);
  return { first, last: rest.join(" ") || null };
}
