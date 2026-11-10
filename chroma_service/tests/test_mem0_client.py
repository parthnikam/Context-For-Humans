"""Tests for the Mem0 Platform client."""

from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException

from chroma_service import mem0_client


class Mem0ClientTests(unittest.TestCase):
    def test_add_memories_sends_one_request_per_entry(self):
        response = Mock(ok=True)
        response.json.return_value = {"results": []}
        with patch.object(mem0_client, "load_mem0_api_key", return_value="unit-test-key"), \
                patch.object(mem0_client.requests, "post", return_value=response) as post:
            added = mem0_client.add_memories([
                {"content": "Project A", "metadata": {"kind": "project"}},
                {"content": "Project B"},
            ])
        self.assertEqual(added, 2)
        self.assertEqual(post.call_count, 2)
        first = post.call_args_list[0].kwargs
        self.assertEqual(first["headers"]["Authorization"], "Token unit-test-key")
        self.assertEqual(first["json"]["messages"][0]["content"], "Project A")
        self.assertEqual(first["json"]["user_id"], mem0_client.DEFAULT_USER_ID)

    def test_search_memories_returns_memory_texts(self):
        response = Mock(ok=True)
        response.json.return_value = {"results": [
            {"memory": "Project A contains React talks."},
            {"memory": ""},
            {"memory": None},
        ]}
        with patch.object(mem0_client, "load_mem0_api_key", return_value="unit-test-key"), \
                patch.object(mem0_client.requests, "post", return_value=response) as post:
            found = mem0_client.search_memories("what about react?")
        self.assertEqual(found, ["Project A contains React talks."])
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["query"], "what about react?")
        self.assertEqual(payload["filters"], {"user_id": mem0_client.DEFAULT_USER_ID})

    def test_search_memories_without_a_key_returns_empty(self):
        with patch.object(mem0_client, "load_mem0_api_key", return_value=""):
            self.assertEqual(mem0_client.search_memories("anything"), [])

    def test_add_memories_without_a_key_adds_nothing(self):
        with patch.object(mem0_client, "load_mem0_api_key", return_value=""):
            self.assertEqual(mem0_client.add_memories([{"content": "Project A"}]), 0)

    def test_connection_requires_a_key(self):
        with patch.object(mem0_client, "load_mem0_api_key", return_value=""):
            with self.assertRaises(HTTPException) as error:
                mem0_client.test_mem0_connection()
        self.assertEqual(error.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
