import { parse } from "csv-parse/sync";
import readXlsxFile from "read-excel-file/node";

/** Lowercases and collapses punctuation so "Job Name", "job_name" and "JOB-NAME" all match. */
export function normHeader(h: string): string {
  return h.replace(/^﻿/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Real exports often put a title line ("Jobsites (exported on ...)") above the
 * headers. Pick the row, among the first ten, that matches the most known column names.
 */
export function tableFromRecords(records: string[][], hints: string[]): ParsedTable {
  const known = new Set(hints);
  let headerAt = 0;
  let best = -1;
  for (let i = 0; i < Math.min(10, records.length - 1); i++) {
    const score = records[i].filter((c) => known.has(normHeader(c))).length;
    if (score > best) { best = score; headerAt = i; }
  }
  if (records.length - headerAt < 2) throw new Error("The file needs a header row and at least one data row");
  const headers = records[headerAt].map(normHeader);
  const rows = records
    .slice(headerAt + 1)
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])))
    .filter((r) => Object.values(r).some(Boolean));
  return { headers, rows };
}

export function parseCsv(text: string, hints: string[] = []): ParsedTable {
  // Excel and Buildertrend exports are sometimes semicolon or tab separated.
  const sample = text.split(/\r?\n/).slice(0, 3).join("\n");
  const delimiter = [",", "\t", ";"].map((d) => [d, sample.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const records: string[][] = parse(text, { delimiter, skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
  return tableFromRecords(records, hints);
}

const cellText = (c: unknown): string => {
  if (c === null || c === undefined) return "";
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c).trim();
};

export async function parseXlsx(buf: Buffer, hints: string[] = []): Promise<ParsedTable> {
  const sheets = await readXlsxFile(buf);
  if (!sheets.length) throw new Error("That spreadsheet has no sheets");
  return tableFromRecords(sheets[0].data.map((r) => r.map(cellText)), hints);
}

/** A file's text (CSV, TSV) or raw bytes (.xlsx). */
export async function readTable(input: string | Buffer, hints: string[]): Promise<ParsedTable> {
  return typeof input === "string" ? parseCsv(input, hints) : parseXlsx(input, hints);
}

/** Finds which file column feeds each of our fields. A column feeds at most one field, earlier fields first. */
export function mapColumns<F extends string>(headers: string[], synonyms: Record<F, string[]>) {
  const map = {} as Record<F, string | undefined>;
  const used = new Set<string>();
  for (const [field, names] of Object.entries(synonyms) as [F, string[]][]) {
    const hit = names.find((n) => headers.includes(n) && !used.has(n));
    map[field] = hit;
    if (hit) used.add(hit);
  }
  return { map, ignored: headers.filter((h) => !used.has(h) && h) };
}

export const allHints = (synonyms: Record<string, string[]>) => Object.values(synonyms).flat();

export function pick<F extends string>(row: Record<string, string>, map: Record<F, string | undefined>, field: F): string {
  const col = map[field];
  return col ? (row[col] ?? "").trim() : "";
}

export interface PersonName {
  first: string | null;
  last: string | null;
  /** Set when the "name" is really a label such as a street address. */
  label: string | null;
}

export function splitName(raw: string): PersonName {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return { first: null, last: null, label: null };
  if (/^\d/.test(cleaned)) return { first: null, last: null, label: cleaned }; // "2935 Lakeshore Blvd"
  if (cleaned.includes(",")) {
    const [last, first] = cleaned.split(",", 2).map((x) => x.trim());
    return { first: first || null, last: last || null, label: null };
  }
  const tokens = cleaned.split(" ").filter((t) => !/^[-–—.,]+$/.test(t)); // "Adonis -"
  const [first, ...rest] = tokens;
  return { first: first ?? null, last: rest.join(" ") || null, label: null };
}
