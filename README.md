# Morrow

This repository now hosts the Morrow-based replacement for the retired React/Node.js application. Application behavior, UI, persona defaults and memory rules are preserved from the deployed Morrow source. Runtime data is not included.

Upstream: [ariaprism/Morrow](https://github.com/ariaprism/Morrow). The deployed source baseline is `4a15ffa324ec0b3e9e7832212a1b3ac721064ef7`. Retain the bundled MIT license and all upstream attribution; this repository does not claim original authorship of Morrow.

## Architecture and production operation

- `app.py` / `wsgi.py`: Flask HTTP application, authentication, SQLite schema and API routes.
- `chat_engine.py`, `tools.py`, focused `*_engine.py` modules: provider streaming, assistant tools and optional background activities.
- `static/`: the existing SPA and PWA; no separate React or frontend build is required.
- `data/`: private runtime SQLite, uploads and other user assets; never version or publish it.
- `deploy/`: deployment examples. Use a dedicated service account and Gunicorn behind a local reverse proxy; do not expose the Flask development server.
- `tests/`: isolated regression tests; `docs/reviews/MORROW-MEMORY-AUDIT-20261027.md` records the source-based memory audit.

Install Python 3.11+ dependencies from `requirements.txt`; install Gunicorn separately for production (`python -m pip install gunicorn`). Copy `.env.example` to a private `.env`, supply a unique access password and signing secret, and configure the provider through supported settings. Never copy production secrets into a template. The bundled systemd example uses a loopback-only listener and a dedicated account. Review its paths for your host before installation. Run `nginx -t` before reloading any proxy changes. See `docs/deployment.zh-CN.md` for details.

Code updates must preserve the runtime data directory, signing secret, authentication and provider configuration. Take a consistent SQLite backup before any future schema upgrade; never restore an old snapshot over newer messages. Optional cloud backups must use a separate private backup repository, not this code repository.

Future development should build on Morrow's existing Flask/SQLite and tool boundaries. The old project's feature plans are not automatically specifications for this codebase. Evaluate memory provenance, revisions and retrieval in isolation before production changes; this handoff does not implement those changes.

## Optional Serein bridge

The optional `serein_bridge.py` adapter keeps model calls and persona configuration in Morrow. It uses an explicitly configured loopback Serein instance, a restricted MCP tool allowlist, and a private sidecar ledger for successful recall deliveries and non-idempotent write outcomes. Missing configuration or a recall outage leaves normal chat usable. `deploy/morrow-serein.example.json` has safe defaults; no credential is included. Setting `MORROW_SEREIN_CONFIG` selects a private configuration file. Do not enable `hook_ready` before embedding, reranking and routes have been tested. `replace_legacy` suppresses old automatic memory injection and normal-chat memory write tools without deleting stored memories; background activity integration is not included.

Raw transcript automatic synchronization is **not enabled**: the pinned Serein source lacks a verified source-edit/version/withdrawal transport. The durable outbox can detect identity/content conflicts but its sender is intentionally blocked, even if a configuration flag is changed. Scene reads/writes and host acknowledgements do not imply transcript synchronization or automatic Event generation. Unknown Scene write outcomes remain blocked across process restarts; inspect them before retrying. This guard does not provide cross-service exactly-once writes.

`aru_import.py` is a pure preview converter for explicitly mapped, timezone-aware Aru-like Markdown. It never imports to a database or fetches attachments; actual Aru exports still need format verification. Retain original export bytes privately.

`serein_backup.py` reuses Morrow's authenticated encryption to snapshot configured SQLite files, include private instance files and verify an actual isolated decryption/restore before publishing an encrypted backup. Restore targets must not exist. The backup does not automatically delete retention generations; keep independent offline recovery credentials and off-host copies. Derived indexes may be rebuilt after restore. Multi-root snapshots are not one atomic transaction: quiesce source writes for an authoritative cross-store recovery point.

Deployment examples use a dedicated Python-only service, loopback access, CPU/memory limits and an optional daily encrypted-backup timer. They do not expose a Serein management website, change DNS or replace Morrow's frontend. The pinned upstream version is recorded in `deploy/serein.config.example.toml`; do not update it automatically.

Memory model choices are now separate controls in Settings → Providers. They store provider/model references rather than credentials. The authenticated `/api/memory/models` API supports revision-checked selection and explicit tiny synthetic validation. Stored provider keys are no longer returned by provider-edit APIs; leaving the key input blank preserves the existing value. Fetching a saved provider's model list reuses its key only if the origin and protocol still match.

The loopback `/internal/memory-models` broker resolves saved credentials on each request, validates response shapes and applies a shared daily limit of 128 provider requests / 20,000 input characters. Serein receives only the broker's private service token. `serein_model_sync.py` refreshes references without inference; `--prepare` is an explicit budgeted operation that prepares indexes/routes. Model selection or selected-provider changes disable Hook until verified preparation. An underlying provider URL change selects a separate index namespace.

`memory_outbox.py` installs additive control/outbox tables and transactional message/session triggers **disabled by default**, without historical backfill. `serein_source_worker.py` is guarded by the existing false withdrawal capability; do not enable its timer. `serein_source_projection.py` is an isolated candidate that can revoke explicitly bound evidence while retaining private source history, not a registered production receiver. Frozen pipeline jobs, unbound authored Scenes and legacy Event reprojection are not yet certified, so real source sync and automatic Event remain off.

**English** | [简体中文](README.zh-CN.md)

Morrow is a private, self-hosted home for long-running AI conversations. It keeps the chat surface calm while memory, tools, model routing, summaries, scheduled activities, backups, and usage records stay behind the wall.

The interface is currently Chinese-first. The codebase is a Flask application with a single-file SPA and SQLite storage.

## What is included

- Streaming chat with OpenAI-compatible and Anthropic providers
- Multiple conversations, branching, continuation windows, message versions, editing, regeneration, and export
- Persona and memory management, summaries, image descriptions, and optional MCP tools
- Notes, todos, weather, diary, keepsakes, listening history, cycle records, and voice letters
- Scheduled room activity, proactive messages, one-shot reminders, and Web Push
- Encrypted ZIP and optional GitHub Release backups
- PWA support for desktop and mobile installation

## Privacy model

Morrow is designed for one trusted household, not as a multi-tenant service. Conversation data, provider keys, MCP credentials, and personal records are stored in the local SQLite database. Keep the data directory and backups private.

Runtime data and credentials must stay outside the published repository, including its Git history. Example secrets used by tests are synthetic.

## Requirements

- Python 3.11 or newer
- Node.js 20 or newer only for the optional music bridge
- An OpenAI-compatible or Anthropic API provider

## Quick start

Clone the repository:

```bash
git clone https://github.com/ariaprism/Morrow.git morrow
cd morrow
python -m venv .venv
```

On Windows PowerShell, activate and install with:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

If PowerShell blocks activation, use `.\.venv\Scripts\python.exe` in place of `python`; activation is optional.

On macOS/Linux:

```bash
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` and set the two required access values before starting:

```dotenv
AUTH_PASSWORD=use-a-long-unique-password
SECRET_KEY=generate-a-random-64-character-value
PORT=5151
FLASK_DEBUG=0
```

To chat using the default DeepSeek connection, also fill in `DEEPSEEK_API_KEY` (or `LLM_API_KEY`). The default address is `https://api.deepseek.com/v1` and the default model is `deepseek-flash`, as listed in the [official model documentation](https://api-docs.deepseek.com/quick_start/pricing/). You can omit `LLM_MODEL` or leave it blank to use that default.

For another provider, set its API address, key and model ID in `.env`, or configure a provider in Settings after login. Authentication and browsing the app do not require an AI key, but sending a message requires a usable provider/key and a model it supports. A model ID still needs to be selected before chatting with a provider that does not support `deepseek-flash`.

| Setting | Required? | Default / purpose |
| --- | --- | --- |
| `AUTH_PASSWORD` | Yes | Password for entering your private app |
| `SECRET_KEY` | Yes for a stable installation | Random session signing secret; keep it stable across restarts |
| `DEEPSEEK_API_KEY` / `LLM_API_KEY` | For chatting through the environment-configured provider | `LLM_API_KEY` takes precedence; providers can also be set up in the UI |
| `LLM_BASE_URL` | Optional | `https://api.deepseek.com/v1`; change for other providers |
| `LLM_MODEL` | Optional with default DeepSeek | Missing or blank uses `deepseek-flash` |
| `PORT` | Optional | `5151`; change it if another app uses this port |
| `FLASK_DEBUG` | Optional | `0`; enable only for local development |
| `DB_PATH` | Optional | `data/nook.db`, a legacy filename kept for compatibility |

`nook.db` is only a filename. The commented `# DB_PATH=...` line does not set anything. Changing a database path does not move old data; back up and migrate the existing file before changing it. Never commit `.env` or the database.

Generate a session secret with:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Start Morrow from the repository root:

```bash
python app.py
```

Open `http://localhost:5151`, enter `AUTH_PASSWORD`, then create a conversation. Check the provider settings before sending your first message. The database and uploads are created automatically under `data/` unless `DB_PATH` is set; do not delete this directory when upgrading. Keep `SECRET_KEY` unchanged across restarts so existing logins remain valid.

The built-in server is suitable for a local first run. It listens on all interfaces; use a production WSGI server and an HTTPS reverse proxy for an internet-facing deployment, with one application process to avoid duplicate scheduled jobs. Keep debug mode disabled. If port 5151 is already in use, change `PORT` in `.env`. If login reports `AUTH_PASSWORD is not configured`, check that `.env` exists beside `app.py` and contains a nonempty password, then restart.

## VPS deployment

For a persistent HTTPS installation, see the detailed [VPS deployment and push testing guide (简体中文)](docs/deployment.zh-CN.md). It covers a single-worker Gunicorn service, the scheduler-aware `wsgi:app` entrypoint, systemd, Caddy, updates, and local notification testing. Ready-to-review configuration examples are in [deploy/](deploy).

## Optional configuration

Display names, persona, model providers and MCP tools can be configured after login. Optional services such as weather, voice, Web Push and cloud backups are not required for first startup. See [.env.example](.env.example) and [configuration details](docs/configuration.md).

## Optional music connection

Install Node.js 20 or newer, then install the pinned bridge dependencies:

```bash
npm ci
```

Restart Morrow if Node.js was installed after the server started. The Python server launches `music_bridge.mjs` automatically when needed; do not run it as a separate service.

In Together, open the three-dot menu and paste a KuGou or NetEase Cloud Music Cookie; the provider is detected automatically. Only paste one provider at a time. Credentials are stored separately on the server and are never returned to the browser. The most recently connected provider is used for new searches; existing favorites and queues keep their original provider.

`METING_KUGOU_COOKIE` and `METING_NETEASE_COOKIE` are optional server-side fallbacks. Without saved credentials the public KuGou catalog remains the default; a sole NetEase fallback selects NetEase. Playback remains subject to the account's permissions and provider availability.

## Testing

```bash
python -m compileall -q -x '(^|[\\/])(?:\.venv|venv|node_modules|data)([\\/]|$)' .
python -m unittest discover -s tests -p "test_*.py"
```

Run tests in a separate checkout without a personal `.env` or runtime data. Set `AUTH_PASSWORD` and `SECRET_KEY` to synthetic values in the environment; tests create temporary databases. With music dependencies installed, also run `node --test tests/music_bridge.test.mjs tests/push_capabilities.test.mjs` (offline provider fixtures).

The automated suite lives in `tests/`. `scripts/stream_chat.py` is an optional manual diagnostic that calls the configured model provider and writes a raw stream log under `data/`; it is not part of the test suite. Review and redact that log before sharing it.

## Optional guarded source receiver

`serein_source_host.py` wraps only the audited Serein revision. The example
`deploy/serein.service` retains loopback binding and resource limits; it does
not install Serein, select models, or enable automatic Event processing.
Use the existing initialized schema v9 instance and private token/config files.
The separate `deploy/serein-source-policy.example.json` defaults to closed.

Source receipts, revisions, epoch barriers, shadow invalidation and Scene host
dependencies are additive. `source_gateway_enabled` also defaults to false.
Keep both the receiver policy and host export disabled until full context
provenance and every memory-writing path have been certified. Incomplete host
context must fail closed rather than bind guessed evidence. Ordinary chat
continues when the optional memory integration is unavailable.

Do not prune source/outbox receipts or restore a legacy ZIP over a synchronized
database. Preserve full consistent instance backups and reconcile both cursors.
Rollback the receiver to its closed state first; do not remove guards while
bridge-derived records remain, and never overwrite newer chat with an old DB.

## Security notes

- Never commit `.env`, `data/`, exports, or backups.
- Put Morrow behind HTTPS before exposing it outside a trusted network.
- Use a unique login password and session secret.
- Treat full and cloud backups as sensitive even though cloud backup assets are encrypted.
- Review every MCP server before enabling it; tools can read or change personal data.
- This is a personal application, not a hardened multi-user identity platform.

Please report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

Morrow is available under the [MIT License](LICENSE).
