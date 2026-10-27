# Contributing

Thank you for helping improve Morrow.

1. Keep changes focused and preserve the "behind the wall" product principle: model, tool, memory, and provider details should not leak into ordinary chat bubbles.
2. Do not commit personal conversations, databases, uploads, API keys, access tokens, hostnames, or backups.
3. Add or update regression tests for behavior changes.
4. Run `python -m compileall -q -x '(^|[\\/])(?:\.venv|venv|node_modules|data)([\\/]|$)' .` and `python -m unittest discover -s tests -p "test_*.py"` before opening a pull request.
5. Explain user-visible changes and any migration or privacy impact in the pull request.

By contributing, you agree that your contribution is licensed under the MIT License.
# Optional memory integration checks

Run `python -m unittest discover -s tests -p "test_serein_bridge.py"` with synthetic environment values for the bridge, ledger, Aru preview and encrypted restore tests. The full standard unittest discovery includes these tests.

`tests/serein_transport_check.py --python <isolated-Serein-interpreter>` is opt-in. It starts and removes only its newly created loopback synthetic instance; it cannot select an existing database or service URL. It makes no real model calls. Run with the Morrow interpreter so its existing HTTP dependencies are available. Do not substitute production configuration or credentials.

`test_memory_models.py` covers the reference-only settings API, credential broker and default-disabled transactional outbox. `serein_projection_check.py` uses an installed pinned Serein interpreter and only a new synthetic database. `serein_semantic_check.py` is explicitly opt-in and makes budgeted real embedding/reranking calls using synthetic memories; it must never run in CI or be given historical transcripts. It reads provider metadata/credentials only through a read-only database attachment and does not copy those keys into test or Serein databases.
