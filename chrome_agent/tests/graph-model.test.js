import assert from "node:assert/strict";
import { graphModel } from "../lib/graph-model.js";

const model = graphModel({
  projects: [
    {
      id: "programming-react",
      name: "React learning",
      categoryId: "programming",
      categoryName: "Programming",
      links: [{ title: "React hooks", url: "https://example.test/react" }],
    },
    {
      id: "programming-python",
      name: "Python utilities",
      categoryId: "programming",
      categoryName: "Programming",
      links: [{ title: "Python scripts", url: "https://example.test/python" }],
    },
    {
      id: "film-reviews",
      name: "Film reviews",
      categoryId: "movies-film",
      categoryName: "Movies and film",
      links: [{ title: "Film notes", url: "https://example.test/film" }],
    },
  ],
});

const categories = model.nodes.filter((node) => node.kind === "category");
const projects = model.nodes.filter((node) => node.kind === "project");
const links = model.nodes.filter((node) => node.kind === "link");
assert.equal(categories.length, 2);
assert.equal(projects.length, 3);
assert.equal(links.length, 3);
assert.equal(model.edges.filter((edge) => edge.kind === "parent").length, 3);
assert.equal(model.edges.filter((edge) => edge.kind === "link").length, 3);
assert.equal(categories.find((node) => node.categoryId === "programming").label, "Programming");

console.log("Category -> project -> conversation graph model checks passed.");
