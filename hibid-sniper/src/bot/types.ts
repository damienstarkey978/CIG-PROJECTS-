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
  endTime: string | null;
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

/** One poll/bid cycle's worth of what a source read off a lot page. */
export interface LotReading {
  currentPrice: number | null;
  minNextBid: number | null;
  endTime: string | null;
  isWinning: boolean;
  isClosed: boolean;
}

/**
 * Anything that can watch a lot and place bids on it. LiveSource (real
 * Playwright browser against hibid.com) and DemoSource (simulated, no
 * network at all) both implement this so engine.ts doesn't care which
 * one it's driving.
 */
export interface LotSource {
  init(): Promise<void>;
  read(lot: Lot): Promise<LotReading>;
  placeBid(lot: Lot, amount: number): Promise<void>;
  dispose(lot: Lot): Promise<void>;
}

export interface SearchResult {
  title: string;
  url: string;
  currentPrice: number | null;
  endTime: string | null;
  thumbnailUrl: string | null;
}
