# Hivemind

Orquestrador local de agentes de programação. Um cliente MCP lidera o job, escolhe os executores e verifica a entrega. O serviço Hivemind mantém o estado compartilhado, controla a fila e registra as evidências em SQLite e Git.

Licença MIT. A infraestrutura roda na sua máquina. Cada CLI usa a autenticação configurada nela e segue os limites e custos do seu provedor.

## Instalação no Windows

Requisitos: Node.js 24, Git 2.45+ e pelo menos um harness instalado para executar tarefas. Para instalar pelo código-fonte:

```powershell
git clone https://github.com/Ald3b4r4n/Hivemind.git
cd Hivemind
npm ci
npm run build
npm install -g .
hivemind init
```

Edite `$env:USERPROFILE\.hivemind\agents.yaml` e aponte o perfil para a raiz de um repositório Git com commit. Use `HIVEMIND_HOME` para escolher outro diretório privado.

```powershell
hivemind doctor
hivemind serve
```

Em outro terminal, rode `hivemind status`, `hivemind profiles` ou `hivemind agents meu-projeto`. Configure seu cliente MCP com `hivemind install <harness> <diretório-do-projeto>`. A CLI copia a skill e imprime o comando ou trecho de configuração para revisão.

No cliente MCP, peça:

> Use a skill hivemind-orchestrator com o perfil meu-projeto. Analise o README, delegue uma melhoria em worktree e peça a outro agente para revisar o commit.

No modo padrão `required`, aprove as tarefas identificadas pelo orquestrador com `hivemind approve <job-id> <task-id>`. Use `hivemind jobs` para localizar jobs.

## Papéis, modelos e effort

Cada agente tem seus próprios `harness`, `roles`, `model`, `effort` e `instructions`. Use várias entradas do mesmo harness para modelos ou níveis diferentes. Um perfil seleciona agentes autorizados e pode ter sua equipe reduzida na criação de um job.

```yaml
agents:
  review:
    harness: codex
    model: gpt-6.1-sol
    roles: [reviewer]
    effort: auto
    autoEffort:
      simple: low
      normal: medium
      complex: xhigh
    instructions: "Priorize regressões e cite arquivos e testes."
```

Os valores do exemplo dependem do catálogo da CLI. Consulte `hivemind agents`, `hivemind doctor` ou `hivemind_list_agents`. O modo `auto` usa a complexidade informada pela tarefa e a tabela do agente, se configurada. Sem tabela, tenta selecionar `low`, `medium` ou `high` quando confirmado para o modelo. Se não houver suporte verificável para a seleção automática padrão, registra `harness-default`. Uma seleção explícita indisponível retorna `EFFORT_UNSUPPORTED`, salvo quando o agente declara `effortFallback`.

Use `hivemind_assign_task` com `effort` para sobrescrever apenas uma tarefa. Para salvar uma definição, edite o YAML com o serviço parado, use `hivemind configure-agent <id> <arquivo-do-agente.yaml>` ou a ferramenta administrativa `hivemind_configure_agent`. Jobs existentes têm uma cópia da equipe. Para abrir um coordenador com modelo, effort e instruções definidos, configure o papel `orchestrator`, instale seu MCP e execute `hivemind coordinate <perfil> <agente> "<objetivo>"`.

- [Integrações de Codex, Claude Code, OpenCode e Antigravity](docs/integracoes.md)
- [Arquitetura, contratos e estados](docs/arquitetura.md)
- [Testes e aceite com CLIs reais](docs/validacao.md)
- [Contribuição](CONTRIBUTING.md) · [Segurança](SECURITY.md)
