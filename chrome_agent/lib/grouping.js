export const DEFAULT_CHROMA_SERVICE_URL = "http://127.0.0.1:8765";
export const DEFAULT_SIMILARITY_THRESHOLD = 0.62;
const MAX_ASSIGNMENT_BATCH_SIZE = 25;

function normalizeServiceUrl(value) {
  return String(value || DEFAULT_CHROMA_SERVICE_URL).trim().replace(/\/+$/, "");
}

async function requestJson(path, {
  serviceUrl = DEFAULT_CHROMA_SERVICE_URL,
  fetch: fetchImpl = globalThis.fetch,
  method = "GET",
  body,
  onDebug,
  service = "Local service",
  stage = path,
} = {}) {
  const url = `${normalizeServiceUrl(serviceUrl)}${path}`;
  const request = {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  onDebug?.({ service, stage, direction: "request", payload: { url, ...request, body } });
  const response = await fetchImpl(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
  }
  onDebug?.({ service, stage, direction: response.ok ? "response" : "error", payload: data });
  if (!response.ok) {
    throw new Error(data.detail || `Service request failed with status ${response.status}`);
  }
  return data;
}

export async function testChromaService(options = {}) {
  return requestJson("/health", {
    ...options,
    service: "ChromaDB",
    stage: "Check service",
  });
}

export async function testOpenAIService(options = {}) {
  return requestJson("/openai-test", {
    ...options,
    method: "POST",
    body: {},
    service: "OpenAI",
    stage: "Test API key",
  });
}

export async function testTypeSafeService(options = {}) {
  return requestJson("/typesafe-test", {
    ...options,
    method: "POST",
    body: {},
    service: "TypeSafe Jev",
    stage: "Test category classifier",
  });
}

export async function listCategories(options = {}) {
  return requestJson("/categories", {
    ...options,
    service: "TypeSafe Jev",
    stage: "Load category taxonomy",
  });
}

export async function searchTitles(query, options = {}) {
  const text = String(query || "").trim();
  if (!text) return { query: "", matches: [] };
  return requestJson("/search", {
    ...options,
    method: "POST",
    body: { query: text, limit: 12 },
    service: "ChromaDB",
    stage: "Similarity search",
  });
}

export async function syncProjectAssignments(assignments, options = {}) {
  if (!assignments.length) return { updated: 0 };
  return requestJson("/assign", {
    ...options,
    method: "POST",
    body: { assignments },
    service: "ChromaDB",
    stage: "Save project assignments",
  });
}

export async function clearChromaIndex(options = {}) {
  return requestJson("/clear", {
    ...options,
    method: "POST",
    service: "ChromaDB",
    stage: "Clear index",
  });
}

export async function groupConversations({
  conversations,
  existingProjects = [],
  similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
  serviceUrl = DEFAULT_CHROMA_SERVICE_URL,
  fetch: fetchImpl = globalThis.fetch,
  onDebug,
} = {}) {
  if (!Array.isArray(conversations) || !conversations.length) return [];
  const clusterResult = await requestJson("/cluster", {
    serviceUrl,
    fetch: fetchImpl,
    method: "POST",
    body: {
      conversations,
      similarity_threshold: similarityThreshold,
    },
    onDebug,
    service: "ChromaDB",
    stage: "Cluster conversation titles",
  });
  const clusters = (clusterResult.clusters || [])
    .map((cluster) => Array.isArray(cluster.conversations) ? cluster.conversations : [])
    .filter((cluster) => cluster.length);
  if (!clusters.length) return [];
  if (clusterResult.categorization) {
    onDebug?.({
      service: "TypeSafe Jev",
      stage: "Classify conversation titles",
      direction: "response",
      payload: clusterResult.categorization,
    });
  }

  const normalizedProjects = existingProjects.map((project) => ({
    id: String(project.id || ""),
    name: String(project.name || ""),
    intent: String(project.intent || ""),
    category_id: String(project.categoryId || "uncategorized"),
    category_name: String(project.categoryName || "Uncategorized"),
    representative_titles: (project.links || []).slice(0, 8).map((link) => link.title),
  }));
  const nonEmptyClusters = (clusterResult.clusters || []).filter(
    (cluster) => Array.isArray(cluster.conversations) && cluster.conversations.length,
  );
  const incomingClusters = clusters.map((items, index) => {
    const sourceCluster = nonEmptyClusters[index];
    return {
      cluster_id: `cluster_${index + 1}`,
      titles: items.map((item) => item.title),
      category_id: String(sourceCluster?.category_id || "uncategorized"),
      category_name: String(sourceCluster?.category_name || "Uncategorized"),
      existing_project_candidates: sourceCluster?.existing_project_candidates || [],
    };
  });

  const assignments = [];
  for (let start = 0; start < incomingClusters.length; start += MAX_ASSIGNMENT_BATCH_SIZE) {
    const batch = incomingClusters.slice(start, start + MAX_ASSIGNMENT_BATCH_SIZE);
    const categoriesInBatch = new Set(batch.map((cluster) => cluster.category_id));
    const eligibleProjects = normalizedProjects.filter((project) => (
      categoriesInBatch.has(project.category_id)
    ));
    const result = await requestJson("/assign-projects", {
      serviceUrl,
      fetch: fetchImpl,
      method: "POST",
      body: {
        existing_projects: eligibleProjects,
        incoming_clusters: batch,
      },
      onDebug,
      service: "OpenAI",
      stage: "Assign projects",
    });
    if (!Array.isArray(result.assignments) || result.assignments.length !== batch.length) {
      throw new Error("The local service returned an invalid project assignment list.");
    }
    const expectedIds = new Set(batch.map((cluster) => cluster.cluster_id));
    for (const assignment of result.assignments) {
      if (!assignment || !expectedIds.delete(assignment.cluster_id)) {
        throw new Error("The local service returned a missing, unknown, or duplicate cluster ID.");
      }
      assignments.push(assignment);
    }
    if (expectedIds.size) {
      throw new Error("The local service did not assign every incoming cluster.");
    }
  }

  const assignmentsById = new Map(assignments.map((assignment) => [assignment.cluster_id, assignment]));
  return clusters.map((items, index) => {
    const incoming = incomingClusters[index];
    const assignment = assignmentsById.get(incoming.cluster_id);
    const existing = normalizedProjects.find((project) => (
      project.id === assignment?.existing_project_id
    ));
    return {
      id: existing?.id || undefined,
      name: existing?.name || assignment?.project_name,
      intent: existing?.intent || assignment?.intent,
      categoryId: incoming.category_id,
      categoryName: incoming.category_name,
      links: items.map((item) => ({ title: item.title, url: item.url })),
    };
  });
}
