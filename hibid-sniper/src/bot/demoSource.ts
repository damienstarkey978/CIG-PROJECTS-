import { Lot, LotReading, LotSource } from "./types";

/**
 * Simulated lot source: no Playwright, no network, no hibid.com at all.
 * Lets the dashboard, engine loop, and bidding logic be exercised and
 * demoed end to end even where a real browser binary isn't available or
 * hasn't been calibrated yet. A fake competing bidder nudges the price up
 * periodically so proxy/snipe behavior is visible.
 */
export class DemoSource implements LotSource {
  private state = new Map<string, { price: number; endTime: number; youAreWinning: boolean }>();

  async init(): Promise<void> {
    // nothing to set up
  }

  private getState(lot: Lot) {
    let s = this.state.get(lot.id);
    if (!s) {
      s = {
        price: 10,
        endTime: Date.now() + 3 * 60_000,
        youAreWinning: false,
      };
      this.state.set(lot.id, s);
    }
    return s;
  }

  async read(lot: Lot): Promise<LotReading> {
    const s = this.getState(lot);

    // A phantom other bidder occasionally outbids you, purely for demo purposes.
    if (!s.youAreWinning && Math.random() < 0.3) {
      s.price += Math.max(1, Math.round(s.price * 0.05));
    }

    const isClosed = Date.now() >= s.endTime;

    return {
      currentPrice: s.price,
      minNextBid: s.price + 1,
      endTime: new Date(s.endTime).toISOString(),
      isWinning: s.youAreWinning,
      isClosed,
    };
  }

  async placeBid(lot: Lot, amount: number): Promise<void> {
    const s = this.getState(lot);
    s.price = amount;
    s.youAreWinning = true;
    // A bid in the closing seconds triggers a soft-close extension, same as real HiBid.
    if (s.endTime - Date.now() < 15_000) {
      s.endTime = Date.now() + 15_000;
    }
  }

  async dispose(): Promise<void> {
    // nothing to tear down
  }
}
