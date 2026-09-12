# Provider Routing

FLYTOWN stores provider routes in `.flytown/terrarium.json` and API keys in
`.flytown/provider-secrets.json`. Environment variables win over saved local
secrets, and keys are never written to `terrarium.json`.

The model client is the `openai` SDK pointed at a base URL, so anything that
exposes an OpenAI-compatible API works. `gpt-5*`, `o*`, `deepseek-r*` and
`*-thinking` models are detected and switched to reasoning-model parameters
automatically. Extra provider-specific request parameters go in
`provider.requestParams` — for example `{"thinking":{"type":"disabled"}}` for
DeepSeek.

## Presets

| Preset | Base URL | Key env var |
| --- | --- | --- |
| OpenAI | default SDK URL | `OPENAI_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Ollama | `http://localhost:11434/v1` | `OLLAMA_API_KEY` (optional; a dummy key is used if unset) |
| LM Studio | `http://localhost:1234/v1` | `LM_API_TOKEN` (only when server authentication is enabled) |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| Together AI | `https://api.together.ai/v1` | `TOGETHER_API_KEY` |
| Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| Anthropic | `https://api.anthropic.com/v1/` | `ANTHROPIC_API_KEY` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` |
| Custom | user supplied | user supplied |

## Slots

Routes are per slot: one for each caste (`forager`, `wasp`, `scout`, `guard`,
`soldier`, `messenger`), plus `scribe` for Artifact distillation and
`embedding` for Artifact retrieval.

```bash
flytown route set forager --preset ollama --model gemma3:27b
flytown route set guard --preset openrouter --model openai/gpt-4o-mini
flytown route set soldier --preset openai --model gpt-5
flytown route set scribe --preset openai --model gpt-4o-mini
```

On the OpenAI preset every chat slot defaults to `gpt-5-mini` except the
soldier, which defaults to `gpt-5`. Mixing backends is the point — for
example cheap local foragers with a hosted soldier.

Slots can be cleared:

```bash
flytown route clear forager
flytown route clear --all
```

`FLYTOWN_MODEL_<SLOT>` environment variables override a slot's model; see the
[CLI reference](cli.md#environment).

## Output Formats

Output can be `freeform`, `markdown`, or `json`: set `--format` on a run, or
the provider's `outputFormat` for the terrarium.

## Secrets

Store a key for the current terrarium (input is hidden, or read from stdin):

```bash
flytown secret set DEEPSEEK_API_KEY
flytown secret list
flytown secret clear DEEPSEEK_API_KEY
```

Common environment variables:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENROUTER_API_KEY`
- `GROQ_API_KEY`
- `TOGETHER_API_KEY`
- `MISTRAL_API_KEY`
- `DEEPSEEK_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`

Do not commit `.flytown/provider-secrets.json`. The whole `.flytown/`
directory is gitignored in this repository; keep it that way in yours.

## Provider Packages

Use `.agents/skills/add-provider-package/SKILL.md` only when a provider needs a
real SDK adapter or package-level integration. For OpenAI-compatible endpoints,
prefer route configuration.
