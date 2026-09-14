export type LotMode = "proxy" | "snipe";

export type LotStatus =
  | "watching"
  | "winning"
  | "outbid"
  | "won"
  | "lost"
  | "error"
  | "paused";

export interface LotLogEntry {
  ts: number;
  message: string;
}

export interface Lot {
  id: string;
  url: string;
  label: string;
  maxBid: number;
  mode: LotMode;
  snipeSeconds: number;
  status: LotStatus;
  currentPrice: number | null;
  minNextBid: number | null;
  endTime: string | null; // ISO string, best-effort estimate read from the page
  lastChecked: number | null;
  paused: boolean;
  log: LotLogEntry[];
}

export interface NewLotInput {
  url: string;
  label?: string;
  maxBid: number;
  mode?: LotMode;
  snipeSeconds?: number;
}
