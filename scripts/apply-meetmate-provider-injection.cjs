const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const pipelinePath = resolve(__dirname, "../node_modules/meetmate/src/pipeline.js");
let source = readFileSync(pipelinePath, "utf8");

if (!source.includes('const llmProvider = options.llmProvider || createLlmProvider({ provider: config?.llm?.provider });')) {
  source = source.replace(
    'const llmProvider = createLlmProvider({ provider: config?.llm?.provider });',
    'const llmProvider = options.llmProvider || createLlmProvider({ provider: config?.llm?.provider });\n  if (!llmProvider || typeof llmProvider.streamChat !== "function") {\n    throw new Error("Pipeline llmProvider must expose streamChat(messages, options).");\n  }',
  );
}
if (!source.includes("const providerManagesHistory = isOpenclawProvider || llmProvider.managesHistory === true;")) {
  source = source.replace(
    'const isOpenclawProvider = llmProvider.name === "openclaw";',
    'const isOpenclawProvider = llmProvider.name === "openclaw";\n  const providerManagesHistory = isOpenclawProvider || llmProvider.managesHistory === true;',
  );
  source = source.replace("const previousTurns = isOpenclawProvider", "const previousTurns = providerManagesHistory");
  source = source.replace("...(!isOpenclawProvider && config.llm.systemPrompt", "...(!providerManagesHistory && config.llm.systemPrompt");
}
if (!source.includes("const pipelineSynthesize = options.synthesize || synthesize;")) {
  source = source.replace(
    "const ttsCache = createTtsCache({ synthesizeFn: synthesize });",
    'const pipelineSynthesize = options.synthesize || synthesize;\n  if (typeof pipelineSynthesize !== "function") {\n    throw new Error("Pipeline synthesize must be a function.");\n  }\n  const ttsCache = createTtsCache({ synthesizeFn: pipelineSynthesize });',
  );
  source = source.replace("const stt = createSTT(dgKey, {", "const stt = options.sttProvider || createSTT(dgKey, {");
  source = source.replace(
    "const synthesizeFn = opts.cacheable === true && usePipelineTtsCache ? ttsCache.synthesize : synthesize;",
    "const synthesizeFn = opts.cacheable === true && usePipelineTtsCache ? ttsCache.synthesize : pipelineSynthesize;",
  );
}

if (!source.includes("options.llmProvider") || !source.includes("providerManagesHistory") || !source.includes("options.sttProvider") || !source.includes("options.synthesize")) {
  throw new Error("Pinned Meetmate pipeline no longer matches the reviewed provider-injection seam.");
}
writeFileSync(pipelinePath, source, "utf8");
