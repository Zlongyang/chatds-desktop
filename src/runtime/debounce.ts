// SPDX-License-Identifier: GPL-3.0-only
// Ported from Mai-with-u/MaiBot, commit 478f671e64467121fd3e39205c8d3507b5ce0bd6.
// Original: src/chat/debounce/controller.py. See third_party/maibot/SOURCE.json.
export type DebounceMode = 'fast' | 'natural' | 'steady';
const PROFILES = { fast: [1, 3, 1, 0.5], natural: [2, 5, 2, 0.5], steady: [4, 7, 4, 2] } as const;
export interface Arrival {
  author: string;
  bareImage?: boolean;
  pureEmoji?: boolean;
  mention?: boolean;
  receivedAt: number;
  wallTime: number;
  now: number;
  mode?: DebounceMode;
}
/** Monotonic seconds; no background timer, network call or model invocation. */
export class MessageDebouncer {
  private first: number | null = null;
  private lastArrival: number | null = null;
  private lastAuthor: string | null = null;
  private urgent: number | null = null;
  deadline: number | null = null;
  observe(a: Arrival): void {
    const waits = PROFILES[a.mode ?? 'natural'];
    let arrival = a.now - Math.max(0, a.wallTime - a.receivedAt);
    const previousArrival = this.lastArrival,
      previousAuthor = this.lastAuthor;
    if (this.lastArrival !== null) arrival = Math.max(arrival, this.lastArrival);
    this.lastArrival = arrival;
    this.lastAuthor = a.author;
    const fresh = this.first === null;
    if (fresh) this.first = arrival;
    if (a.mention) {
      const urgent = a.now - Math.max(0, a.wallTime - a.receivedAt) + 1;
      this.urgent = this.urgent === null ? urgent : Math.min(this.urgent, urgent);
    }
    if (this.deadline === null || this.deadline > a.now) {
      const limit = Math.min(this.first! + 8, this.urgent ?? Infinity);
      let wait: number;
      if (fresh) {
        wait = previousArrival !== null && arrival - previousArrival <= 30 ? waits[1] : waits[0];
        if (a.bareImage) wait = Math.max(wait, 4);
      } else wait = a.author === previousAuthor ? waits[2] : waits[3];
      let candidate = arrival + wait;
      if (a.pureEmoji && !fresh) candidate = Math.min(candidate, this.deadline!);
      this.deadline = Math.min(candidate, limit);
    }
  }
  finish(now: number): void {
    if (this.deadline !== null) this.deadline = Math.min(this.deadline, now);
  }
  consume(): void {
    this.first = null;
    this.deadline = null;
    this.urgent = null;
  }
}
