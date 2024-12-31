import { DeepseekKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;

export class DeepseekKeyChecker {
  private log = logger.child({ module: "key-checker", service: "deepseek" });

  constructor(private readonly update: (hash: string, key: Partial<DeepseekKey>) => void) {}

  public async checkKey(key: DeepseekKey): Promise<void> {
    try {
      const result = await this.validateKey(key);
      this.handleCheckResult(key, result);
    } catch (error) {
      this.log.warn(
        { error, hash: key.hash },
        "Failed to check key status"
      );
    }
  }

  private async validateKey(key: DeepseekKey): Promise<"valid" | "invalid" | "quota"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.key}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 0,
        }),
        signal: controller.signal,
      });

      const rateLimit = {
        limit: parseInt(response.headers.get("x-ratelimit-limit") || "200"),
        remaining: parseInt(response.headers.get("x-ratelimit-remaining") || "199"),
      };

      switch (response.status) {
        case 400:
          this.log.debug(
            { key: key.hash, rateLimit },
            "Key check successful, updating rate limit info"
          );
          return "valid";
        case 401:
          return "invalid";
        case 402:
          return "quota";
        case 429:
          this.log.warn({ key: key.hash }, "Key is rate limited");
          return "valid";
        default:
          this.log.warn(
            { status: response.status, hash: key.hash },
            "Unexpected status code while checking key"
          );
          return "valid";
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleCheckResult(
    key: DeepseekKey,
    result: "valid" | "invalid" | "quota"
  ): void {
    switch (result) {
      case "valid":
        this.update(key.hash, {
          isDisabled: false,
          lastChecked: Date.now(),
        });
        break;
      case "invalid":
        this.log.warn({ hash: key.hash }, "Key is invalid");
        this.update(key.hash, {
          isDisabled: true,
          isRevoked: true,
          lastChecked: Date.now(),
        });
        break;
      case "quota":
        this.log.warn({ hash: key.hash }, "Key has exceeded its quota");
        this.update(key.hash, {
          isDisabled: true,
          lastChecked: Date.now(),
        });
        break;
      default:
        assertNever(result);
    }
  }
}