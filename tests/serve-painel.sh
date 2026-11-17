#!/bin/bash
export PATH="${HOME}/.deno/bin:${PATH}"
export OKX_BASE=http://127.0.0.1:8788
export OKX_API_KEY=key-pupo
export OKX_API_SECRET=test-secret
export OKX_API_PASSPHRASE=test-pass
export OKX2_API_KEY=key-pai
export OKX2_API_SECRET=test-secret
export OKX2_API_PASSPHRASE=test-pass
export OKX3_API_KEY=key-mae
export OKX3_API_SECRET=test-secret
export OKX3_API_PASSPHRASE=test-pass
export OKX4_API_KEY=key-tcheco
export OKX4_API_SECRET=test-secret
export OKX4_API_PASSPHRASE=test-pass
export TRADER_PANEL_PASSWORD=teste
export PANEL_SESSION_SECRET=segredo-de-teste-painel
export PANEL_ORIGINS=http://127.0.0.1:4173
export PANEL_PORT=8000
# sem SUPABASE_URL o backend se trata como local e recusa qualquer OKX fora de loopback
unset SUPABASE_URL
cd "$(dirname "$0")/.."
# rede só em 127.0.0.1: escuta na 8000 e fala com o mock na 8788. O Deno nega qualquer outro host (inclusive a OKX real).
exec deno run --allow-env --allow-net=127.0.0.1 supabase/functions/painel/index.ts
