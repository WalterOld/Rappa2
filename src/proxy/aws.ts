/* Shared code between AWS Claude and AWS Mistral endpoints. */

import { Request, Response, Router } from "express";
import { config } from "../config";
import { addV1 } from "./add-v1";
import { awsClaude } from "./aws-claude";
import { awsMistral } from "./aws-mistral";
import { AwsBedrockKey, keyPool } from "../shared/key-management";

const awsRouter = Router();
awsRouter.get(["/:vendor?/v1/models", "/:vendor?/models"], handleModelsRequest);
awsRouter.use("/claude", addV1, awsClaude);
awsRouter.use("/mistral", addV1, awsMistral);

const MODELS_CACHE_TTL = 10000;
let modelsCache: Record<string, any> = {};
let modelsCacheTime: Record<string, number> = {};
function handleModelsRequest(req: Request, res: Response) {
  if (!config.awsCredentials) return { object: "list", data: [] };

  const vendor = req.params.vendor?.length
    ? req.params.vendor === "claude"
      ? "anthropic"
      : req.params.vendor
    : "all";

  const cacheTime = modelsCacheTime[vendor] || 0;
  if (new Date().getTime() - cacheTime < MODELS_CACHE_TTL) {
    return res.json(modelsCache[vendor]);
  }

  const availableModelIds = new Set<string>();
  for (const key of keyPool.list()) {
    if (key.isDisabled || key.service !== "aws") continue;
    (key as AwsBedrockKey).modelIds.forEach((id) => availableModelIds.add(id));
  }

  const modelDisplayNames = new Map([
    ["anthropic.claude-v2", "Claude 2"],
    ["anthropic.claude-v2:1", "Claude 2.1"],
    ["anthropic.claude-3-haiku-20240307-v1:0", "Claude 3 Haiku"],
    ["anthropic.claude-3-5-haiku-20241022-v1:0", "Claude 3.5 Haiku"],
    ["anthropic.claude-3-sonnet-20240229-v1:0", "Claude 3 Sonnet"],
    ["anthropic.claude-3-5-sonnet-20240620-v1:0", "Claude 3.5 Sonnet (Old)"],
    ["anthropic.claude-3-5-sonnet-20241022-v2:0", "Claude 3.5 Sonnet (New)"],
    ["anthropic.claude-3-opus-20240229-v1:0", "Claude 3 Opus"],
    ["mistral.mistral-7b-instruct-v0:2", "Mistral 7B Instruct"],
    ["mistral.mixtral-8x7b-instruct-v0:1", "Mixtral 8x7B Instruct"],
    ["mistral.mistral-large-2402-v1:0", "Mistral Large 2402"],
    ["mistral.mistral-large-2407-v1:0", "Mistral Large 2407"],
    ["mistral.mistral-small-2402-v1:0", "Mistral Small 2402"],
  ]);

  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html
  const models = Array.from(modelDisplayNames.keys())
    .filter((id) => availableModelIds.has(id))
    .map((id) => {
      const vendor = id.match(/^(.*)\./)?.[1];
      const date = new Date();
      return {
        // Common
        id,
        owned_by: vendor,
        // Anthropic
        type: "model",
        display_name: modelDisplayNames.get(id) || id.split('.')[1],
        created_at: date.toISOString(),
        // OpenAI
        object: "model",
        created: date.getTime(),
        permission: [],
        root: vendor,
        parent: null,
      };
    });

  modelsCache[vendor] = {
    // Common
    object: "list",
    data: models.filter((m) => vendor === "all" || m.root === vendor),
    // Anthropic
    has_more: false,
    first_id: models[0]?.id,
    last_id: models[models.length - 1]?.id,
  };
  modelsCacheTime[vendor] = new Date().getTime();

  return res.json(modelsCache[vendor]);
}

export const aws = awsRouter;
