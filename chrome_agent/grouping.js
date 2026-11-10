const MEM0_HOST = "https://api.mem0.ai";
const GEMINI_HOST = "https://generativelanguage.googleapis.com/v1beta/models";
const MEM0_USER_ID = "conversation-exporter";
const MEM0_SIMILARITY_THRESHOLD = 0.6;
const MEM0_CONCURRENCY = 8;
const MEM0_SEARCH_LIMIT = 100;
const MEM0_POLL_INTERVAL_MS = 1000;
const MEM0_EVENT_TIMEOUT_MS = 120000;
const GEMMA_MODELS = ["gemma-4-26b-a4b-it", "gemma-4-31b-it"];
const GEMMA_BATCH_SIZE = 40;
const GEMMA_BATCH_CHAR_LIMIT = 25000;
const TITLES_PER_CLUSTER = 12;

const GROUP_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          intent: { type: "string" },
        },
        required: ["id", "name", "intent"],
      },
    },
  },
  required: ["groups"],
};

export async function testMem0Key(apiKey, options = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Enter a Mem0 API key to test.");
  await requestJson(options.fetch ?? globalThis.fetch, `${MEM0_HOST}/v1/ping/`, {
    method: "GET",
    headers: { Authorization: `Token ${key}` },
  }, "Mem0");
  return { ok: true };
}

export async function testGeminiKey(apiKey, options = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Enter a Gemini API key to test.");
  await generateWithFallback(key, {
    contents: [{ role: "user", parts: [{ text: "Reply with the single word ok." }] }],
  }, options.fetch ?? globalThis.fetch);
  return { ok: true };
}

export async function groupConversations({
  mem0ApiKey,
  geminiApiKey,
  conversations,
  onStatus = () => {},
  fetch: doFetch = globalThis.fetch,
  similarityThreshold = MEM0_SIMILARITY_THRESHOLD,
  pollIntervalMs = MEM0_POLL_INTERVAL_MS,
  eventTimeoutMs = MEM0_EVENT_TIMEOUT_MS,
} = {}) {
  const mem0Key = String(mem0ApiKey || "").trim();
  const geminiKey = String(geminiApiKey || "").trim();
  if (!mem0Key) throw new Error("Save a Mem0 API key in AI grouping settings first.");
  if (!geminiKey) throw new Error("Save a Gemini API key in AI grouping settings first.");
  if (!Array.isArray(conversations) || !conversations.length) {
    throw new Error("There are no conversations to group.");
  }
  if (!Number.isFinite(similarityThreshold) || similarityThreshold < 0 || similarityThreshold > 1) {
    throw new Error("The Mem0 similarity threshold must be between 0 and 1.");
  }

  const runId = globalThis.crypto?.randomUUID?.();
  if (!runId) throw new Error("This browser cannot create a secure Mem0 run identifier.");

  onStatus(`Indexing ${conversations.length} titles in Mem0...`);
  const eventIds = await mapLimit(conversations, MEM0_CONCURRENCY, async (conversation, index) => {
    const data = await requestJson(doFetch, `${MEM0_HOST}/v3/memories/add/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${mem0Key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: conversation.title }],
        user_id: MEM0_USER_ID,
        run_id: runId,
        infer: false,
        metadata: { source: "chrome_agent", conversation_index: index },
      }),
    }, "Mem0");
    if (!data.event_id) throw new Error(`Mem0 did not return an indexing event for title ${index + 1}.`);
    return { eventId: data.event_id, status: data.status };
  });

  onStatus("Waiting for Mem0 to finish indexing conversation titles...");
  await mapLimit(eventIds, MEM0_CONCURRENCY, ({ eventId, status }) => {
    if (status === "SUCCEEDED") return Promise.resolve();
    return waitForMem0Event(doFetch, mem0Key, eventId, pollIntervalMs, eventTimeoutMs);
  });

  let searched = 0;
  onStatus("Finding similar titles with Mem0...");
  const similarityResults = await mapLimit(conversations, MEM0_CONCURRENCY, async (conversation, index) => {
    const data = await requestJson(doFetch, `${MEM0_HOST}/v3/memories/search/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${mem0Key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: conversation.title,
        filters: { user_id: MEM0_USER_ID, run_id: runId },
        top_k: Math.min(conversations.length, MEM0_SEARCH_LIMIT),
        threshold: similarityThreshold,
        rerank: false,
      }),
    }, "Mem0");
    const results = Array.isArray(data.results) ? data.results : [];
    const ownRecordFound = results.some((result) =>
      Number(result?.metadata?.conversation_index) === index
    );
    if (!ownRecordFound) {
      throw new Error(`Mem0 did not return title ${index + 1} in its own similarity search.`);
    }
    searched += 1;
    if (searched % 25 === 0 || searched === conversations.length) {
      onStatus(`Finding similar titles with Mem0 (${searched}/${conversations.length})...`);
    }
    return results.map((result) => ({
      sourceIndex: index,
      targetIndex: Number(result?.metadata?.conversation_index),
      score: Number(result?.score),
    })).filter((result) =>
      Number.isInteger(result.targetIndex) &&
      result.targetIndex >= 0 &&
      result.targetIndex < conversations.length &&
      result.targetIndex !== index &&
      Number.isFinite(result.score) &&
      result.score >= similarityThreshold
    );
  });

  const clusters = clusterBySimilarity(conversations.length, similarityResults);
  const namedProjects = await nameClusters(geminiKey, clusters, conversations, {
    fetch: doFetch,
    onStatus,
  });
  return namedProjects.map((project, index) => ({
    id: `project-${index + 1}`,
    name: project.name,
    intent: project.intent,
    links: project.indices.map((conversationIndex) => conversations[conversationIndex]),
  }));
}

export function clusterBySimilarity(itemCount, similarityResults) {
  const parent = Array.from({ length: itemCount }, (_, index) => index);
  const rank = Array(itemCount).fill(0);
  const find = (value) => {
    if (parent[value] !== value) parent[value] = find(parent[value]);
    return parent[value];
  };
  const union = (left, right) => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (rank[leftRoot] < rank[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    parent[rightRoot] = leftRoot;
    if (rank[leftRoot] === rank[rightRoot]) rank[leftRoot] += 1;
  };

  for (const resultSet of similarityResults) {
    for (const result of resultSet) union(result.sourceIndex, result.targetIndex);
  }

  const clustersByRoot = new Map();
  for (let index = 0; index < itemCount; index += 1) {
    const root = find(index);
    const indices = clustersByRoot.get(root) || [];
    indices.push(index);
    clustersByRoot.set(root, indices);
  }
  return [...clustersByRoot.values()];
}

async function nameClusters(apiKey, clusters, conversations, { fetch: doFetch, onStatus }) {
  const namesById = new Map();
  const multiLinkClusters = [];
  for (const [id, indices] of clusters.entries()) {
    if (indices.length > 1) {
      multiLinkClusters.push({ id, indices });
      continue;
    }
    const title = String(conversations[indices[0]]?.title || "").trim();
    namesById.set(id, {
      name: title.slice(0, 80) || "Unrelated conversation",
      intent: "No other conversation title met the Mem0 similarity threshold.",
    });
  }

  const batches = makeGemmaBatches(multiLinkClusters, conversations);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    onStatus(`Naming Mem0 clusters with Gemma (${batchIndex + 1}/${batches.length})...`);
    const response = await generateJson(apiKey, batch, doFetch);
    const expectedIds = new Set(batch.map((cluster) => cluster.id));
    for (const group of response.groups) {
      if (!Number.isInteger(group?.id) || !expectedIds.has(group.id) || namesById.has(group.id)) {
        throw new Error("Gemma returned an invalid or duplicate cluster id.");
      }
      const name = String(group.name || "").trim();
      if (!name) throw new Error(`Gemma did not provide a name for similarity cluster ${group.id + 1}.`);
      namesById.set(group.id, {
        name,
        intent: String(group.intent || "").trim(),
      });
    }
  }

  if (namesById.size !== clusters.length) {
    throw new Error("Gemma did not return a title for every Mem0 similarity cluster.");
  }
  return clusters.map((indices, id) => ({
    ...namesById.get(id),
    indices,
  }));
}

function makeGemmaBatches(clusters, conversations) {
  const batches = [];
  let batch = [];
  let charCount = 0;
  for (const { id, indices } of clusters) {
    const titles = [];
    const seen = new Set();
    for (const index of indices) {
      const title = String(conversations[index].title || "").trim().slice(0, 240);
      const key = title.toLocaleLowerCase();
      if (!title || seen.has(key)) continue;
      seen.add(key);
      titles.push(title);
      if (titles.length === TITLES_PER_CLUSTER) break;
    }
    const cluster = { id, titles: titles.length ? titles : ["Untitled conversation"] };
    const clusterSize = JSON.stringify(cluster).length;
    if (batch.length && (
      batch.length >= GEMMA_BATCH_SIZE ||
      charCount + clusterSize > GEMMA_BATCH_CHAR_LIMIT
    )) {
      batches.push(batch);
      batch = [];
      charCount = 0;
    }
    batch.push(cluster);
    charCount += clusterSize;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function generateJson(apiKey, batch, doFetch) {
  const prompt = [
    "Give each supplied conversation cluster a short, descriptive project name and one-sentence intent.",
    "The clusters were already formed by Mem0 similarity. Do not merge, split, move, or omit clusters.",
    "Return exactly one result for every input id, preserving its id.",
    "",
    "Clusters (id and representative conversation titles):",
    JSON.stringify(batch),
  ].join("\n");
  const structuredBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: GROUP_SCHEMA,
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  };

  let response;
  try {
    response = await generateWithFallback(apiKey, structuredBody, doFetch);
  } catch (error) {
    if (![400, 500, 503].includes(error.status)) throw error;
    response = await generateWithFallback(apiKey, {
      contents: [{
        role: "user",
        parts: [{ text: `${prompt}\n\nReply with one JSON object and no other text.` }],
      }],
    }, doFetch);
  }
  let parsed;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error("Gemma returned invalid JSON for similarity cluster names.");
  }
  if (!Array.isArray(parsed?.groups)) {
    throw new Error("Gemma response did not contain a groups list.");
  }
  return parsed;
}

async function generateWithFallback(apiKey, body, doFetch) {
  let lastError;
  for (const model of GEMMA_MODELS) {
    try {
      const data = await requestJson(
        doFetch,
        `${GEMINI_HOST}/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body),
        },
        "Gemini",
      );
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .filter((part) => part?.text && !part.thought)
        .map((part) => part.text)
        .join("")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      if (!text) throw new Error("Gemini returned no project names.");
      return text;
    } catch (error) {
      lastError = error;
      if (![404, 500, 503].includes(error.status)) throw error;
    }
  }
  throw lastError || new Error("Gemini request failed.");
}

async function waitForMem0Event(doFetch, apiKey, eventId, pollIntervalMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    const event = await requestJson(
      doFetch,
      `${MEM0_HOST}/v1/event/${encodeURIComponent(eventId)}/`,
      { method: "GET", headers: { Authorization: `Token ${apiKey}` } },
      "Mem0",
    );
    const status = String(event?.status || event?.event?.status || "").toUpperCase();
    if (status === "SUCCEEDED") return;
    if (status === "FAILED") throw new Error(`Mem0 failed to index event ${eventId}.`);
  }
  throw new Error(`Timed out while waiting for Mem0 to index event ${eventId}.`);
}

async function requestJson(doFetch, url, init, service) {
  let response;
  try {
    response = await doFetch(url, init);
  } catch {
    throw new Error(`Could not reach ${service}.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || data?.detail || data?.error || data?.message;
    const message = typeof detail === "string" ? detail : `${service} request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function mapLimit(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
