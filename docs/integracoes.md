# Configurar um cliente MCP

Rode `hivemind serve` e, no projeto de trabalho, rode o instalador correspondente. Os quatro clientes usam a mesma skill e podem chamar os mesmos contratos de coordenação. O instalador preserva um arquivo de skill já presente e imprime a configuração a aplicar.

| Cliente | Comando | Aplicação |
| --- | --- | --- |
| Codex | `hivemind install codex .` | Execute o comando `codex mcp add` retornado. Confirme com `codex mcp list` e abra nova sessão. |
| Claude Code | `hivemind install claude-code .` | Execute o comando `claude mcp add` retornado e confirme com `claude mcp list` ou `/mcp`. |
| OpenCode 2 | `hivemind install opencode .` | Incorpore a entrada em `mcp.servers` no `opencode.json` ou JSONC existente. Confirme com `opencode mcp list`. |
| Google Antigravity | `hivemind install antigravity .` | Incorpore a entrada `mcpServers.hivemind` no arquivo retornado ou no gerenciador MCP da IDE. Recarregue os servidores. |

A entrada STDIO usa o Node diretamente e aponta para `hivemind bridge` com o diretório de dados. Clientes HTTP podem usar `http://127.0.0.1:17844/mcp`, ajustando a porta, com cabeçalho `Authorization: Bearer` e o valor de `access.token`. Guarde esse valor na configuração local do cliente. Em Codex, por exemplo, use `bearer_token_env_var` para apontar para uma variável de ambiente. A chave administrativa fica em `admin.token` e é usada pela CLI para aprovar execuções e editar agentes.

Para iniciar um coordenador pelo cliente, peça “Carregue a skill hivemind-orchestrator, liste os perfis e coordene o job no perfil escolhido”. Em clientes que não carregam a skill automaticamente, leia o recurso `hivemind://skills/orchestrator`.

No Codex não interativo, a aprovação de ferramentas MCP é controlada pela configuração do próprio Codex. Para um servidor local que você decidiu autorizar, configure `mcp_servers.hivemind.default_tools_approval_mode` no Codex conforme sua política. O teste de aceite autoriza somente o servidor da fixture temporária e exclui a ferramenta administrativa. Os modos de aprovação de tarefas no Hivemind continuam aplicáveis.

## Execução

- Codex CLI usa `codex exec` com sandbox `read-only` ou `workspace-write` conforme a tarefa. No Windows, o adapter padrão prefere o sandbox nativo MXC quando disponível e permitido pelo Codex. O modo workspace-write e as políticas efetivas continuam aplicáveis. O adapter padrão usa a sessão existente e ignora a configuração pessoal do CLI para executar tarefas. Um provedor personalizado definido no perfil usa a configuração local do Codex.
- Claude Code usa modo de impressão, desativa hooks por configuração e seleciona ferramentas de leitura ou edição para a execução. A autenticação normal do CLI permanece disponível. Tarefas de edição usam o modo nativo `acceptEdits`.
- OpenCode 2 usa `opencode run --standalone` com permissões de leitura ou edição. Selecione um modelo habilitado da sua conta. Use um modelo com preço zero ou local se precisar garantir custo incremental zero. `doctor` detecta a CLI e o catálogo disponível.
- Antigravity tem instalação como cliente MCP e skill. Para versões da IDE que mantêm MCP no gerenciador do aplicativo, abra a configuração bruta nesse gerenciador e incorpore `mcpServers.hivemind`. A primeira versão reserva a execução programática aos três adapters CLI acima.

Para uma instalação fora do PATH, defina `harnesses.<harness>.executable` com caminho absoluto para o executável nativo ou ponto de entrada Node. O Hivemind reconhece shims npm conhecidos no Windows e chama o binário diretamente. Configure `harnesses.<harness>.forwardEnv` com nomes de variáveis estritamente necessárias ao provedor. Use o login oficial de cada CLI.

- [MCP no Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [MCP no Claude Code](https://code.claude.com/docs/en/mcp)
- [MCP no OpenCode](https://opencode.ai/docs/mcp-servers/)
- [MCP no Antigravity](https://antigravity.google/docs/mcp)
