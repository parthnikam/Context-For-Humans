import assert from "node:assert/strict";
import {
  askQuestion,
  clearChromaIndex,
  clusterOpenTabs,
  groupConversations,
  listCategories,
  searchTitles,
  syncProjectAssignments,
  testChromaService,
  testMem0Service,
  testOpenAIService,
  testTypeSafeService,
} from "../lib/grouping.js";

const calls = [];
const debugRecords = [];
const incoming = [
  { title: "React hooks guide", url: "https://provider-a.test/1" },
  { title: "React hooks examples", url: "https://provider-b.test/2" },
  { title: "Weekend soup recipe", url: "https://provider-c.test/3" },
];
const existingProjects = [{
  id: "project-react",
  name: "React project",
  intent: "Build and learn React interfaces.",
  categoryId: "programming",
  categoryName: "Programming",
  links: [
    { title: "React state patterns", url: "https://provider-old.test/1" },
    { title: "React component guide", url: "https://provider-old.test/2" },
  ],
}];

const fakeFetch = async (url, init = {}) => {
  const parsedUrl = new URL(url);
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ url: parsedUrl, init, body });

  if (parsedUrl.pathname === "/health") {
    return jsonResponse({ ok: true, stored_titles: 25, openai_configured: true });
  }
  if (parsedUrl.pathname === "/openai-test") {
    return jsonResponse({ ok: true, model: "gpt-5.6-luna" });
  }
  if (parsedUrl.pathname === "/typesafe-test") {
    return jsonResponse({ ok: true, model: "jev-latest", category: "Programming" });
  }
  if (parsedUrl.pathname === "/mem0-test") {
    return jsonResponse({ ok: true });
  }
  if (parsedUrl.pathname === "/ask") {
    assert.ok(body.question.trim().length >= 1);
    return jsonResponse({
      answer: "You filed React Hooks.",
      model: "gpt-5.6-luna",
      sources: [{ title: "React hooks guide", url: incoming[0].url }],
      projects: ["React Hooks"],
    });
  }
  if (parsedUrl.pathname === "/cluster-tabs") {
    assert.ok(body.tabs.length >= 1);
    return jsonResponse({
      model: "gpt-5.6-luna",
      trails: [{ label: "React work", one_liner: "Learning React.", tab_ids: body.tabs.map((tab) => tab.id) }],
    });
  }
  if (parsedUrl.pathname === "/categories") {
    return jsonResponse({
      categories: [
        { id: "programming", name: "Programming", description: "Code." },
        { id: "movies-film", name: "Movies and film", description: "Films." },
      ],
    });
  }
  if (parsedUrl.pathname === "/search") {
    return jsonResponse({
      query: body.query,
      matches: [{
        title: "React hooks guide",
        url: incoming[0].url,
        project_id: "project-react",
        similarity: 0.82,
      }],
    });
  }
  if (parsedUrl.pathname === "/cluster") {
    return jsonResponse({
      indexed_titles: incoming.length,
      stored_titles: 28,
      similarity_threshold: body.similarity_threshold,
      categorization: {
        model: "jev-latest",
        category_count: 134,
        titles: [
          { title: incoming[0].title, category_id: "programming", category_name: "Programming" },
          { title: incoming[1].title, category_id: "programming", category_name: "Programming" },
          { title: incoming[2].title, category_id: "cooking-recipes", category_name: "Cooking and recipes" },
        ],
      },
      clusters: [
        {
          cluster_id: "cluster-0",
          category_id: "programming",
          category_name: "Programming",
          conversations: incoming.slice(0, 2),
          existing_project_candidates: [{
            project_id: "project-react",
            name: "React project",
            similarity: 0.81,
            matched_title: "React state patterns",
          }],
        },
        {
          cluster_id: "cluster-1",
          category_id: "cooking-recipes",
          category_name: "Cooking and recipes",
          conversations: incoming.slice(2),
          existing_project_candidates: [],
        },
      ],
    });
  }
  if (parsedUrl.pathname === "/assign-projects") {
    assert.match(JSON.stringify(body.existing_projects), /React project/);
    assert.match(JSON.stringify(body.existing_projects), /React state patterns/);
    assert.match(JSON.stringify(body.incoming_clusters), /Weekend soup recipe/);
    assert.doesNotMatch(JSON.stringify(body), /provider-a\.test/);
    return jsonResponse({
      model: "gpt-5.6-luna",
      assignments: body.incoming_clusters.map((cluster, index) => (
        index === 0
          ? {
            cluster_id: cluster.cluster_id,
            existing_project_id: "project-react",
            project_name: "",
            intent: "",
          }
          : {
            cluster_id: cluster.cluster_id,
            existing_project_id: "",
            project_name: "Cooking",
            intent: "Collect cooking and recipe conversations.",
          }
      )),
    });
  }
  if (parsedUrl.pathname === "/assign") {
    return jsonResponse({ updated: body.assignments.length });
  }
  if (parsedUrl.pathname === "/clear") {
    return jsonResponse({ cleared: true });
  }
  throw new Error(`Unexpected request: ${url}`);
};

assert.equal((await testChromaService({ fetch: fakeFetch })).stored_titles, 25);
assert.deepEqual(await testOpenAIService({ fetch: fakeFetch }), {
  ok: true,
  model: "gpt-5.6-luna",
});
assert.deepEqual(await testTypeSafeService({ fetch: fakeFetch }), {
  ok: true,
  model: "jev-latest",
  category: "Programming",
});
assert.deepEqual(await testMem0Service({ fetch: fakeFetch }), { ok: true });
const asked = await askQuestion("what was I working on?", { fetch: fakeFetch });
assert.equal(asked.answer, "You filed React Hooks.");
assert.equal(asked.sources.length, 1);
assert.equal(asked.projects[0], "React Hooks");
const clustered = await clusterOpenTabs(
  [{ id: 1, title: "React docs", url: "https://provider-a.test/1" }],
  [{ name: "React project", intent: "" }],
  { fetch: fakeFetch },
);
assert.equal(clustered.trails[0].label, "React work");
assert.deepEqual(clustered.trails[0].tab_ids, [1]);
await assert.rejects(() => askQuestion("   ", { fetch: fakeFetch }), /Ask a question first/);
assert.deepEqual((await listCategories({ fetch: fakeFetch })).categories.map((category) => category.id), [
  "programming",
  "movies-film",
]);
assert.deepEqual(await searchTitles("react components", {
  fetch: fakeFetch,
  onDebug: (entry) => debugRecords.push(entry),
}), {
  query: "react components",
  matches: [{
    title: "React hooks guide",
    url: incoming[0].url,
    project_id: "project-react",
    similarity: 0.82,
  }],
});

const projects = await groupConversations({
  conversations: incoming,
  existingProjects,
  similarityThreshold: 0.67,
  fetch: fakeFetch,
  onDebug: (entry) => debugRecords.push(entry),
});

assert.deepEqual(projects.map((project) => project.id), ["project-react", undefined]);
assert.deepEqual(projects.map((project) => project.name), ["React project", "Cooking"]);
assert.deepEqual(projects.map((project) => project.categoryId), ["programming", "cooking-recipes"]);
assert.deepEqual(projects.map((project) => project.links.map((link) => link.title)), [
  ["React hooks guide", "React hooks examples"],
  ["Weekend soup recipe"],
]);
assert.equal(calls.find((call) => call.url.pathname === "/cluster").body.similarity_threshold, 0.67);
const assignmentRequest = calls.find((call) => call.url.pathname === "/assign-projects");
assert.equal(assignmentRequest.init.method, "POST");
assert.ok(debugRecords.some((entry) => entry.service === "ChromaDB" && entry.direction === "response"));
assert.ok(debugRecords.some((entry) => entry.service === "TypeSafe Jev" && entry.direction === "response"));
assert.ok(debugRecords.some((entry) => entry.service === "OpenAI" && entry.direction === "request"));
assert.ok(debugRecords.some((entry) => entry.stage === "Similarity search" && entry.direction === "request"));
assert.doesNotMatch(JSON.stringify(debugRecords), /api[_-]?key|authorization/i);
assert.ok(calls.every((call) => !call.url.hostname.includes("openai.com")));

assert.deepEqual(await syncProjectAssignments([{
  title: "React hooks guide",
  url: incoming[0].url,
  project_id: "project-react",
  project_name: "React project",
}], { fetch: fakeFetch }), { updated: 1 });
assert.deepEqual(await clearChromaIndex({ fetch: fakeFetch }), { cleared: true });
const assignmentCall = calls.find((call) => call.url.pathname === "/assign");
assert.equal(assignmentCall.body.assignments.length, 1);
const clearCall = calls.find((call) => call.url.pathname === "/clear");
assert.equal(clearCall.init.method, "POST");

console.log("Persistent Chroma clustering and OpenAI project assignment checks passed.");

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
