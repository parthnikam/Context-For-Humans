const CHROMA_API = "http://127.0.0.1:8765";
const GEMINI_HOST = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMMA_MODELS = ["gemma-4-26b-a4b-it", "gemma-4-31b-it"];
const CLUSTER_BATCH_SIZE = 25;

export const DEFAULT_SIMILARITY_THRESHOLD = 0.62;

const ASSIGNMENT_SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cluster_id: { type: "string" },
          existing_project_id: { type: "string" },
          project_name: { type: "string" },
          intent: { type: "string" },
        },
        required: ["cluster_id", "existing_project_id", "project_name", "intent"],
      },
    },
  },
  required: ["assignments"],
};

export async function testChromaService(options = {}) {
  const data = await requestJson(
    options.fetch ?? globalThis.fetch,
    `${CHROMA_API}/health`,
    { method: "GET" },
    "ChromaDB",
    options.onDebug,
    "Check local Chroma service",
  );
  if (!data.ok) throw new Error("The local ChromaDB service did not report ready.");
  return data;
}

export async function clearChromaIndex(options = {}) {
  return requestJson(
    options.fetch ?? globalThis.fetch,
    `${CHROMA_API}/clear`,
    { method: "POST" },
    "ChromaDB",
    options.onDebug,
    "Clear local Chroma index",
  );
}

export async function syncProjectAssignments(assignments, options = {}) {
  if (!assignments.length) return { updated: 0 };
  return requestJson(
    options.fetch ?? globalThis.fetch,
    `${CHROMA_API}/assign`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignments }),
    },
    "ChromaDB",
    options.onDebug,
    "Save project assignments in Chroma",
  );
}

export async function groupConversations({
  geminiApiKey,
  conversations,
  existingProjects = [],
  onStatus = () => {},
  onDebug = () => {},
  fetch: doFetch = globalThis.fetch,
  similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
} = {}) {
  const apiKey = String(geminiApiKey || "").trim();
  if (!apiKey) throw new Error("Save a Gemini API key in AI grouping settings first.");
  if (!Array.isArray(conversations) || !conversations.length) {
    throw new Error("There are no conversations to group.");
  }
  if (!Number.isFinite(similarityThreshold) || similarityThreshold < 0 || similarityThreshold > 1) {
    throw new Error("The Chroma cosine similarity threshold must be between 0 and 1.");
  }

  onStatus(`Finding persistent title similarities in ChromaDB (${conversations.length} titles)...`);
  const clustered = await requestJson(doFetch, `${CHROMA_API}/cluster`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversations,
      similarity_threshold: similarityThreshold,
    }),
  }, "ChromaDB", onDebug, "Cluster conversation titles");
  if (!Array.isArray(clustered.clusters)) {
    throw new Error("ChromaDB did not return a clusters list.");
  }

  const clusters = clustered.clusters;
  const normalizedProjects = existingProjects.map((project) => ({
    id: String(project.id),
    name: String(project.name || "").trim(),
    intent: String(project.intent || "").trim(),
    example_titles: (project.links || [])
      .slice(0, 3)
      .map((link) => String(link.title || "").trim())
      .filter(Boolean),
  }));
  const assigned = [];
  const seenClusterIds = new Set();
  for (let offset = 0; offset < clusters.length; offset += CLUSTER_BATCH_SIZE) {
    const batch = clusters.slice(offset, offset + CLUSTER_BATCH_SIZE);
    onStatus(`Asking Gemma to assign projects (${Math.floor(offset / CLUSTER_BATCH_SIZE) + 1}/${Math.ceil(clusters.length / CLUSTER_BATCH_SIZE)})...`);
    const response = await assignClusters(apiKey, batch, normalizedProjects, doFetch, onDebug);
    assigned.push(...response);
    for (const assignment of response) {
      if (seenClusterIds.has(assignment.cluster_id)) {
        throw new Error(`ChromaDB returned duplicate cluster id ${assignment.cluster_id}.`);
      }
      seenClusterIds.add(assignment.cluster_id);
    }
  }

  const projectById = new Map(normalizedProjects.map((project) => [project.id, project]));
  const resultByProject = new Map();
  for (const assignment of assigned) {
    const cluster = clusters.find((item) => item.cluster_id === assignment.cluster_id);
    if (!cluster) throw new Error(`Gemma assigned unknown Chroma cluster ${assignment.cluster_id}.`);
    const existing = projectById.get(assignment.existing_project_id);
    const projectId = existing?.id || `new:${assignment.cluster_id}`;
    const name = existing?.name || String(assignment.project_name || "").trim();
    if (!name) throw new Error(`Gemma did not name new cluster ${assignment.cluster_id}.`);
    const project = resultByProject.get(projectId) || {
      id: projectId,
      name,
      intent: existing?.intent || String(assignment.intent || "").trim(),
      links: [],
    };
    project.links.push(...cluster.conversations);
    if (!project.intent && assignment.intent) project.intent = assignment.intent;
    resultByProject.set(projectId, project);
  }

  return [...resultByProject.values()];
}

async function assignClusters(apiKey, clusters, existingProjects, doFetch, onDebug) {
  const payload = {
    existing_projects: existingProjects,
    incoming_clusters: clusters.map((cluster) => ({
      cluster_id: String(cluster.cluster_id),
      titles: (cluster.conversations || []).map((item) => item.title),
      similar_existing_projects: cluster.existing_project_candidates || [],
    })),
  };
  const prompt = [
    "You organize chat conversation titles into durable projects.",
    "The incoming clusters were created by a persistent local ChromaDB vector index. Their membership is fixed; never split, merge, or move conversations between clusters.",
    "For every incoming cluster, either assign it to exactly one existing project or create a new project.",
    "Reuse an existing project only when the titles clearly refer to the same ongoing work. Similar wording or the same chat provider alone is not enough.",
    "Use similar_existing_projects as useful evidence, not as a requirement. Also compare against every existing project name and example title.",
    "If no existing project is a clear fit, set existing_project_id to an empty string and provide a concise, specific project_name and a one-sentence intent.",
    "When reusing an existing project, return its exact id and leave project_name empty. Do not invent project ids.",
    "Return exactly one assignment per incoming cluster, preserving each cluster_id exactly.",
    "",
    "Existing projects and representative titles:",
    JSON.stringify(payload.existing_projects),
    "",
    "Incoming fixed clusters and ChromaDB matches:",
    JSON.stringify(payload.incoming_clusters),
  ].join("\n");
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: ASSIGNMENT_SCHEMA,
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  };
  let text;
  try {
    text = await generateWithFallback(apiKey, body, doFetch, onDebug, "Assign incoming clusters");
  } catch (error) {
    if (![400, 500, 503].includes(error.status)) throw error;
    text = await generateWithFallback(apiKey, {
      contents: [{
        role: "user",
        parts: [{ text: `${prompt}\n\nReturn one JSON object only.` }],
      }],
    }, doFetch, onDebug, "Assign incoming clusters fallback");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemma returned invalid JSON while assigning project groups.");
  }
  if (!Array.isArray(parsed?.assignments) || parsed.assignments.length !== clusters.length) {
    throw new Error(`Gemma returned ${parsed?.assignments?.length || 0} assignments for ${clusters.length} clusters.`);
  }

  const expected = new Map(clusters.map((cluster) => [String(cluster.cluster_id), cluster]));
  const outputById = new Map(parsed.assignments.map((item) => [String(item?.cluster_id || ""), item]));
  const idsAreValid = outputById.size === clusters.length &&
    [...outputById.keys()].every((id) => expected.has(id));
  const ordered = idsAreValid
    ? clusters.map((cluster) => outputById.get(String(cluster.cluster_id)))
    : parsed.assignments;
  if (!idsAreValid) {
    onDebug({
      service: "Gemini",
      stage: "Validate project assignments",
      direction: "warning",
      payload: { message: "Invalid or duplicate cluster IDs; mapped complete response in input order." },
    });
  }

  const existingIds = new Set(existingProjects.map((project) => project.id));
  return ordered.map((item, index) => {
    const clusterId = String(clusters[index].cluster_id);
    const requestedProjectId = String(item?.existing_project_id || "");
    const existingProjectId = existingIds.has(requestedProjectId) ? requestedProjectId : "";
    return {
      cluster_id: clusterId,
      existing_project_id: existingProjectId,
      project_name: existingProjectId ? "" : String(item?.project_name || "").trim(),
      intent: String(item?.intent || "").trim(),
    };
  });
}

export async function testGeminiKey(apiKey, options = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Enter a Gemini API key to test.");
  await generateWithFallback(key, {
    contents: [{ role: "user", parts: [{ text: "Reply with the single word ok." }] }],
  }, options.fetch ?? globalThis.fetch, options.onDebug, "Test Gemini API key");
  return { ok: true };
}

async function generateWithFallback(apiKey, body, doFetch, onDebug = () => {}, stage = "Gemini request") {
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
        onDebug,
        `${stage} (${model})`,
      );
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .filter((part) => part?.text && !part.thought)
        .map((part) => part.text)
        .join("")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      if (!text) throw new Error("Gemini returned no project assignments.");
      return text;
    } catch (error) {
      lastError = error;
      if (![404, 500, 503].includes(error.status)) throw error;
    }
  }
  throw lastError || new Error("Gemini request failed.");
}

async function requestJson(doFetch, url, init, service, onDebug = () => {}, stage = "API request") {
  const parsedUrl = new URL(url);
  const request = {
    method: init?.method || "GET",
    endpoint: `${parsedUrl.origin}${parsedUrl.pathname}`,
    payload: parseRequestBody(init?.body),
  };
  onDebug({ service, stage, direction: "request", payload: request });
  let response;
  try {
    response = await doFetch(url, init);
  } catch {
    const message = service === "ChromaDB"
      ? "Could not reach the local ChromaDB service. Start it with the command in chrome_agent/README.md."
      : `Could not reach ${service}.`;
    onDebug({ service, stage, direction: "error", payload: { message } });
    throw new Error(message);
  }
  const data = await response.json().catch(() => ({}));
  onDebug({
    service,
    stage,
    direction: "response",
    payload: { status: response.status, ok: response.ok, body: data },
  });
  if (!response.ok) {
    const detail = data?.error?.message || data?.detail || data?.error || data?.message;
    const message = typeof detail === "string" ? detail : `${service} request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function parseRequestBody(body) {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
