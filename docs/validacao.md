# Validação

## Suíte automatizada

```powershell
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

A suíte usa adapters determinísticos e subprocessos locais. Verifica dois clientes simultâneos (HTTP e STDIO), esquema de entrada, autenticação por job, transferência de liderança, configuração administrativa, persistência e retomada, dependências, paralelismo, aprovação, timeout, cancelamento, commits, revisão isolada, limpeza e redação. O workflow do GitHub Actions roda no Windows e no Ubuntu.

## Aceite com CLIs reais

A fixture cria seu próprio repositório e ativa aprovação delegada. As autenticações são as das CLIs existentes. Use um modelo de OpenCode com acesso já configurado e custo autorizado. As variáveis de modelo e effort de Codex e Claude Code são opcionais.

```powershell
$env:HIVEMIND_TEST_OPENCODE_MODEL = "provider/model"
npm run test:real
npm run test:real -- codex
npm run test:real -- opencode
```

O primeiro comando de teste usa um cliente SDK para orquestrar e valida arquitetura, implementação com commit e revisão por CLIs reais. O segundo executa o cenário de ponta a ponta com o próprio Codex como cliente MCP. O terceiro dá a liderança ao OpenCode em outro job. A saída mostra o estado de cada tarefa e o effort de cada tentativa. Use `HIVEMIND_KEEP_FIXTURE=1` para preservar o repositório e o SQLite para diagnóstico local.

## Windows 11

| Harness | Resultado | Evidência |
| --- | --- | --- |
| Codex CLI 0.166.0 | PASS em leitura e revisão | Executor com `gpt-6.1-sol`, effort `low`. A escrita com Codex ficou bloqueada pela política local de sandbox. |
| Claude Code 2.1.292 | PASS como executor | Implementou a mudança de README em worktree e produziu commit com `claude-sonnet-4-6`, effort `low`. |
| OpenCode 2.2.6 | PASS como executor e coordenador | Analisou a fixture com `opencode-go/beam-free#low` e finalizou um job separado como cliente MCP. |
| Google Antigravity | NOT TESTED | IDE detectada. Instalação da skill e configuração do cliente documentadas. |

O cliente SDK finalizou o job com a análise do OpenCode, o commit do Claude Code e a revisão do Codex. A branch principal do repositório de teste permaneceu intacta. As execuções usaram os logins existentes e um modelo de OpenCode identificado como gratuito para a fixture.
