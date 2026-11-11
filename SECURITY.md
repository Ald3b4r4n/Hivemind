# Segurança

O serviço é local e escuta em `127.0.0.1`. A validação de Host e Origin bloqueia origens externas. O token de acesso autoriza conexão ao MCP e a chave por job autoriza controle e leitura. A chave administrativa aprova tarefas em perfis `required`, edita agentes e limpa worktrees. Proteja o diretório `HIVEMIND_HOME` com permissões da sua conta. No Windows, confira a ACL herdada.

Use perfis e repositórios confiáveis. Worktrees isolam alterações Git. Os controles adicionais de arquivo e shell dependem do harness e da política do host. A fronteira do processo local é a conta do operador. Configurações, plugins e ferramentas instaladas no harness devem ser confiáveis. Defina apenas as variáveis necessárias em `forwardEnv`. O modo `unattended` deve ser habilitado pelo operador para um perfil autorizado e mantém o sandbox nativo do harness.

A execução Windows usa um Job Object vinculado ao supervisor e ao PID do processo pai. O cancelamento encerra o supervisor da tentativa e sua árvore. O histórico passa por redação de padrões de credenciais e segredos conhecidos, com limites de tamanho. Revise evidências antes de publicá-las.

Relate falhas de segurança pelo canal privado de vulnerabilidades do repositório, se disponível. Evite anexar chaves, prompts privados ou dumps de estado.
