import { Request, RequestHandler, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  applyQuotaLimits,
  addAnthropicPreamble,
  blockZoomerOrigins,
  createPreprocessorMiddleware,
  finalizeBody,
  languageFilter,
  removeOriginHeaders,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.anthropicKey) return { object: "list", data: [] };

  const claudeVariants = [
    "claude-v1",
    "claude-v1-100k",
    "claude-instant-v1",
    "claude-instant-v1-100k",
    "claude-v1.3",
    "claude-v1.3-100k",
    "claude-v1.2",
    "claude-v1.0",
    "claude-instant-v1.1",
    "claude-instant-v1.1-100k",
    "claude-instant-v1.0",
    "claude-2", // claude-2 is 100k by default it seems
    "claude-2.0",
  ];

  const models = claudeVariants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "anthropic",
    permission: [],
    root: "claude",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const rewriteAnthropicRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    applyQuotaLimits,
    addKey,
    addAnthropicPreamble,
    languageFilter,
    blockZoomerOrigins,
    removeOriginHeaders,
    finalizeBody,
  ];

  try {
    for (const rewriter of rewriterPipeline) {
      rewriter(proxyReq, req, res, {});
    }
  } catch (error) {
    req.log.error(error, "Error while executing proxy rewriter");
    proxyReq.destroy(error as Error);
  }
};

/** Only used for non-streaming requests. */
const anthropicResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (config.promptLogging) {
    const host = req.get("host");
    body.proxy_note = `Prompts are logged on this proxy instance. See ${host} for more information.`;
  }

  if (req.inboundApi === "openai") {
    req.log.info("Transforming Anthropic response to OpenAI format");
    body = transformAnthropicResponse(body, req);
  }

  // TODO: Remove once tokenization is stable
  if (req.debug) {
    body.proxy_tokenizer_debug_info = req.debug;
  }

  res.status(200).json(body);
};

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAnthropicResponse(
  anthropicBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "ant-" + anthropicBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: anthropicBody.completion?.trim(),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const anthropicProxy = createQueueMiddleware(
  createProxyMiddleware({
    target: "https://api.anthropic.com",
    changeOrigin: true,
    on: {
      proxyReq: rewriteAnthropicRequest,
      proxyRes: createOnProxyResHandler([anthropicResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
    pathRewrite: {
      // Send OpenAI-compat requests to the real Anthropic endpoint.
      "^/v1/chat/completions": "/v1/complete",
    },
  })
);

const anthropicRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
anthropicRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
anthropicRouter.get("/v1/models", handleModelRequest);
anthropicRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "anthropic", outApi: "anthropic" }),
  anthropicProxy
);
// OpenAI-to-Anthropic compatibility endpoint.
anthropicRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "anthropic" }),
  anthropicProxy
);
// Redirect browser requests to the homepage.
anthropicRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const anthropic = anthropicRouter;
