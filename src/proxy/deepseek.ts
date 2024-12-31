import { Request, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";

const deepseekResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

const deepseekProxy = createQueuedProxyMiddleware({
  mutations: [addKey, finalizeBody],
  target: "https://api.deepseek.com/beta",
  blockingResponseHandler: deepseekResponseHandler,
});

const deepseekRouter = Router();

// combines all the assistant messages at the end of the context and adds the
// beta 'prefix' option, makes prefills work the same way they work for Claude
function enablePrefill(req: Request) {
  // If you want to disable
  if (process.env.NO_DEEPSEEK_PREFILL) return
  
  const msgs = req.body.messages;
  if (msgs.at(-1)?.role !== 'assistant') return;

  let i = msgs.length - 1;
  let content = '';
  
  while (i >= 0 && msgs[i].role === 'assistant') {
    // maybe we should also add a newline between messages? no for now.
    content = msgs[i--].content + content;
  }
  
  msgs.splice(i + 1, msgs.length, { role: 'assistant', content, prefix: true });
}


deepseekRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "deepseek" },
    { afterTransform: [ enablePrefill ] }
  ),
  deepseekProxy
);

export const deepseek = deepseekRouter;