import assert from "node:assert/strict";
import { appendGraphData, moveConversation } from "../lib/graph-state.js";

const projects = [
  {
    id: "p1",
    name: "Old name",
    links: [
      { title: "Conversation A", url: "https://example.test/a" },
      { title: "Conversation B", url: "https://example.test/b" },
    ],
  },
  {
    id: "p2",
    name: "Other project",
    categoryId: "uncategorized",
    links: [{ title: "Conversation C", url: "https://example.test/c" }],
  },
];

const moved = moveConversation(projects, "p1", "p2", "https://example.test/a");
assert.deepEqual(moved[0].links.map((link) => link.url), ["https://example.test/b"]);
assert.deepEqual(moved[1].links.map((link) => link.url), [
  "https://example.test/c",
  "https://example.test/a",
]);
assert.equal(projects[0].links.length, 2);
assert.throws(
  () => moveConversation(projects, "p1", "p2", "https://example.test/missing"),
  /no longer belongs/,
);
assert.equal(moveConversation(projects, "p1", "p1", "https://example.test/a"), projects);
assert.throws(
  () => moveConversation(
    [{ ...projects[0], categoryId: "programming" }, { ...projects[1], categoryId: "movies-film" }],
    "p1",
    "p2",
    "https://example.test/a",
  ),
  /same category/,
);

const appended = appendGraphData(
  projects,
  [
    { title: "Conversation A", url: "https://example.test/a#old" },
    { title: "Conversation B", url: "https://example.test/b" },
    { title: "Conversation C", url: "https://example.test/c" },
  ],
  [
    {
      id: "project-1",
      name: "Old name",
      categoryId: "uncategorized",
      intent: "Merged intent",
      links: [
        { title: "New conversation", url: "https://example.test/new" },
        { title: "Duplicate URL", url: "https://example.test/a#new" },
      ],
    },
    {
      id: "p2",
      name: "Fresh project",
      categoryId: "uncategorized",
      intent: "",
      links: [{ title: "Fresh link", url: "https://example.test/fresh" }],
    },
  ],
  [
    { title: "New conversation", url: "https://example.test/new" },
    { title: "Duplicate URL", url: "https://example.test/a#new" },
    { title: "Fresh link", url: "https://example.test/fresh" },
  ],
);
assert.equal(appended.projects.length, 3);
assert.equal(appended.projects[0].links.length, 3);
assert.equal(appended.projects[1].id, "p2");
assert.notEqual(appended.projects[2].id, "p2");
assert.equal(appended.conversations.length, 5);
assert.ok(appended.conversations.some((item) => item.url === "https://example.test/fresh"));
assert.equal(appended.projects[0].links.filter((link) => link.url.includes("/a")).length, 1);
const separatedCategories = appendGraphData(
  [{ id: "prog", name: "Project A", categoryId: "programming", links: [] }],
  [{ title: "Existing", url: "https://example.test/existing" }],
  [{ name: "Project A", categoryId: "movies-film", categoryName: "Movies and film", links: [
    { title: "New", url: "https://example.test/new-category" },
  ] }],
  [{ title: "New", url: "https://example.test/new-category" }],
);
assert.equal(separatedCategories.projects.length, 2, "same names in different categories stay separate");
assert.equal(projects[0].links.length, 2, "append does not mutate prior graph data");

console.log("Graph conversation reassignment checks passed.");
