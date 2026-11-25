# Data Visualizer

## Environment setup

Docker Compose reads environment variables from `.env` in the repository root. It does not load `.env.example` directly. In Command Prompt, create your local environment file with:

```cmd
copy .env.example .env
```

Edit `.env` before starting the services. The root `.env` is ignored by Git; do not commit API keys or other secrets.

### API settings

| Variable | Purpose |
| --- | --- |
| `PORT` | API port on the host and in the container. Defaults to `3000`. |
| `WEB_ORIGIN` | Web app origin allowed by the API. Defaults to `http://localhost:4200`. |
| `DATABASE_URL` | PostgreSQL connection string. With Docker Compose, the hostname must be `postgres`, not `localhost`. |
| `CREDENTIAL_ENCRYPTION_KEY` | Private encryption key for stored connection credentials. Replace the example value with a unique secret of at least 32 bytes. |

### AI provider settings

Set `AI_PROVIDER` to `deepseek`, `openai`, or `custom`, and set `AI_MODEL` to a model supported by that provider.

- DeepSeek: set `DEEPSEEK_API_KEY`.
- OpenAI: set `OPENAI_API_KEY`; optionally change `OPENAI_BASE_URL` for a compatible API endpoint.
- Custom: set `AI_CHAT_COMPLETIONS_URL` to the provider base URL or full `/chat/completions` URL. Set `AI_API_KEY` if the endpoint requires a Bearer token.

Leave credentials for unused providers blank. AI features remain unavailable until the selected provider's required settings are configured.

## Run with Docker Compose

From the repository root, run:

```cmd
docker compose up --build
```

Open the web app at <http://localhost:4200>. The API is available at <http://localhost:3000>. To stop the services, press `Ctrl+C` and run `docker compose down`.

If the API cannot connect to PostgreSQL, check that `DATABASE_URL` uses `@postgres:5432` when the API runs in Docker. `localhost` inside a container refers to that container, not the PostgreSQL service.