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
cd "$(dirname "$0")/.."
exec deno run -A supabase/functions/painel/index.ts
