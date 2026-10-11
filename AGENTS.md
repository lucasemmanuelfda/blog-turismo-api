# AGENTS.md

Instruções lidas pelo **opencode** ao trabalhar neste repositório.

Repo público de um blog de turismo com geração de conteúdo por IA.

## Stack e estrutura

- `app/` — API FastAPI (Python). `config.py` lê tudo de `.env` via pydantic-settings.
- `worker/` — Cloudflare Worker (frontend SSR: sitemap, robots, JSON-LD, HTML indexável).
- `.github/workflows/` — `atualizar-blog.yml`: um único workflow faz tudo (gerar artigos + publicar agendados + deploy do worker). Roda à meia-noite (cron) ou manualmente. Não exige push para o worker publicar — rodar manualmente após editar o `worker/`.

## Comandos

```bash
python -m uvicorn app.main:app --reload   # dev, http://127.0.0.1:8000/docs
pytest tests                              # testes da API
node worker/test-worker.mjs               # testes do worker
gh workflow run atualizar-blog.yml        # gera + publica + deploy do worker, sem acompanhar — usar sempre
```

## Segurança (repo público)

- Nunca commitar segredos. Tudo sensível vem de env/CI secrets; nunca colar chaves em código ou README.
- `ADMIN_KEY` vazio + `production` => rotas de escrita fechadas (fail-closed). Sem comparar com `!=` (usar `secrets.compare_digest`).
- Conteúdo de IA tratado como não-confiável: escapar na renderização, `rel="nofollow noopener"` em links externos.

## Memória ("segundo cérebro")

`app/services/memory.py` acumula fatos e títulos já publicados por tema em
`blog-memory.json` e injeta um resumo compacto nos prompts da IA (evita repetição).
Fatos vêm da IA e **não são verificados** — nunca afirmar como verdade querida.

## Modo Ponytail (Lazy Senior Dev)

Neste repositório, atue como um desenvolvedor sênior pragmático: o melhor código é o código que não precisou ser escrito. Resolva qualquer problema com a menor alteração completa.

### A Escada de Decisão (pare no primeiro degrau que atender):
1. **YAGNI (You Ain't Gonna Need It)**: Não crie abstrações, opções ou complexidades extras não solicitadas.
2. **Reutilização**: Verifique e reutilize helpers, funções e padrões já existentes no projeto antes de criar novos.
3. **Biblioteca padrão / Plataforma**: Priorize a stdlib do Python e APIs nativas da Cloudflare/Web antes de cogitar soluções externas.
4. **Dependências existentes**: Nunca adicione novos pacotes para o que as bibliotecas já instaladas fazem.
5. **Legibilidade e concisão**: Se puder ser resolvido em poucas linhas claras, resolva em poucas linhas.
6. **Mínimo que funciona**: Faça a menor alteração que resolve integralmente a tarefa.
7. **Segurança e corretude sempre preservadas**: Tratamento de exceções, validação de entradas, testes e segurança de dados nunca são comprometidos.