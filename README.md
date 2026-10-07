# feature-flags-js

[![CI](https://github.com/Ph20sr/feature-flags-js/actions/workflows/ci.yml/badge.svg)](https://github.com/Ph20sr/feature-flags-js/actions/workflows/ci.yml)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**Feature flags** sem servidor e sem serviço pago: libere uma função nova para 10% dos clientes, depois 50%, depois todos, e **desligue na hora** se algo der errado. Também serve para testes A/B. Não tem dependências e roda no Node, no navegador e em edge functions.

## O que garante

- **Rollout estável e monotônico**: cada usuário cai sempre no mesmo "balde" (hash FNV-1a do id). Quem entrou com 10% **continua** com 20%, e ninguém fica alternando entre a versão nova e a antiga.
- **Sorteios independentes**: os 10% da flag A não são os mesmos 10% da flag B, então os mesmos clientes não viram cobaia de tudo
- **Kill switch**: `enabled: false` desliga para todos, inclusive para a lista de permissão
- **Listas** de permissão (equipe, clientes beta) e de bloqueio
- **Regras por atributo**: só plano Pro, só Brasil, só lojas do segmento X
- **Janela de tempo**: liga e desliga sozinha (Black Friday)
- **A/B com pesos**: `{ controle: 50, desconto10: 30, frete_gratis: 20 }`, estável por usuário
- **`explain()`** responde o suporte: "por que o cliente X não está vendo?"

## Uso

```js
import { createFlags } from 'feature-flags-js';

const flags = createFlags({
  novoCheckout: { rollout: 25, allow: ['equipe-1', 'equipe-2'] },
  relatorioIA: { rules: [{ attribute: 'plan', in: ['pro', 'enterprise'] }] },
  pagamentoPix2: { enabled: false },                                   // kill switch
  blackFriday: { startsAt: '2026-11-27T03:00:00Z', endsAt: '2026-11-28T03:00:00Z' },
  precos: { variants: { controle: 50, desconto10: 30, frete_gratis: 20 } },
});

const ctx = { userId: cliente.id, attributes: { plan: cliente.plano, country: 'BR' } };

if (flags.isEnabled('novoCheckout', ctx)) { /* ... */ }
flags.variant('precos', ctx);            // 'desconto10' (sempre o mesmo para este cliente)
flags.explain('novoCheckout', ctx);      // { enabled: false, reason: 'fora do rollout de 25% (balde 6120)' }

// No back-end, mande todas de uma vez para o front-end:
res.json({ flags: flags.evaluateAll(ctx) });   // { novoCheckout: true, relatorioIA: false, ..., precos: 'controle' }
```

### Ordem de decisão

1. flag inexistente → desligada
2. `enabled: false` → desligada para todos
3. fora da janela `startsAt` / `endsAt` → desligada
4. na lista `deny` → desligada
5. na lista `allow` → **ligada**
6. alguma `rule` não atendida → desligada
7. `rollout` (padrão 100%) pelo balde do usuário

Sem `userId`, um rollout parcial fica desligado em vez de sortear às cegas a cada requisição.

### De onde vêm as definições

Um arquivo JSON versionado, uma tabela no banco ou variáveis de ambiente. A biblioteca só avalia, e você escolhe onde guardar. Para mudar sem deploy, leia as definições do banco com um cache curto (ex.: 30 s).

## Desenvolvimento

```bash
npm test
```

Os testes verificam estatisticamente, com 20 mil usuários, a proporção do rollout e das variantes, a monotonicidade e a independência entre flags.

## Licença

MIT
