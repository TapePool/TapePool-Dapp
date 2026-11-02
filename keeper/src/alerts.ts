// Telegram alerts (SPEC-PHASE3-KEEPER §4.6, §7). The bot only sends; it never reads incoming messages.
import { log, redact } from "./log.js";

const THROTTLE_SEC = 30 * 60;

export class Alerts {
  private last = new Map<string, number>();

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly prefix: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Send `text`, at most once per `kind` per 30 minutes unless `always`. Never throws. */
  async send(kind: string, text: string, always = false): Promise<void> {
    const t = this.now();
    const prev = this.last.get(kind);
    if (!always && prev !== undefined && t - prev < THROTTLE_SEC) return;
    this.last.set(kind, t);
    const body = redact(`${this.prefix} ${text}`);
    log("warn", "alert", { kind, text: body });
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: body, disable_web_page_preview: true }),
      });
      if (!res.ok) log("error", "telegram send failed", { status: res.status });
    } catch (e) {
      log("error", "telegram send failed", { error: redact(String(e)) });
    }
  }
}
