#!/usr/bin/env bash
# Intercept Claude Code network calls to see exactly what headers/body it sends.
# Usage: ./scripts/intercept-claude.sh [model]
#
# Starts a local proxy, runs Claude CLI through it, and saves the full request
# to a private /tmp/claude-intercept.XXXXXX/N-{headers,body}.json for analysis.
# Credential headers are redacted in the saved files.

set -euo pipefail

MODEL="${1:-claude-sonnet-4-6}"

umask 077
OUT=$(mktemp -d /tmp/claude-intercept.XXXXXX)
PROXY_PID=
trap '[[ -z $PROXY_PID ]] || kill "$PROXY_PID" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM

echo "=== Claude Code Network Interceptor ==="
echo "Model: $MODEL"
echo "Output: $OUT"
echo ""

# Start interceptor proxy on a free loopback port; it writes the port to $OUT/port
INTERCEPT_DIR="$OUT" node -e "
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const dir = process.env.INTERCEPT_DIR;
let count = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    count++;
    const file = path.join(dir, String(count));
    const headers = { ...req.headers };
    for (const k of ['authorization', 'x-api-key']) if (headers[k]) headers[k] = '<redacted>';
    fs.writeFileSync(file + '-headers.json', JSON.stringify({
      method: req.method,
      url: req.url,
      headers
    }, null, 2));
    fs.writeFileSync(file + '-body.json', body);

    console.error('[REQ ' + count + '] ' + req.method + ' ' + req.url);

    // Print key headers
    const h = req.headers;
    console.error('  auth: ' + (h.authorization ? 'Bearer ...' + h.authorization.slice(-8) : h['x-api-key'] ? 'API key ...' + h['x-api-key'].slice(-8) : 'NONE'));
    console.error('  beta: ' + (h['anthropic-beta'] || 'NONE'));
    console.error('  ua:   ' + (h['user-agent'] || 'NONE'));

    // Print body structure
    try {
      const parsed = JSON.parse(body);
      console.error('  body keys: ' + Object.keys(parsed).sort().join(', '));
      console.error('  model: ' + parsed.model);
      console.error('  tools: ' + (parsed.tools?.length || 0));
      console.error('  system blocks: ' + (parsed.system?.length || 0));
      if (parsed.thinking) console.error('  thinking: ' + JSON.stringify(parsed.thinking));
      if (parsed.metadata) console.error('  metadata: present');
    } catch {}

    // Forward to real API
    const opts = {
      hostname: 'api.anthropic.com',
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: 'api.anthropic.com' }
    };
    const proxy = https.request(opts, proxyRes => {
      console.error('  -> ' + proxyRes.statusCode);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxy.write(body);
    proxy.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(dir, 'port'), String(port));
  console.error('Proxy ready on 127.0.0.1:' + port);
  console.error('');
});

setTimeout(() => { server.close(); process.exit(0); }, 60000);
" &
PROXY_PID=$!
for _ in {1..50}; do
  [[ -s "$OUT/port" ]] && break
  sleep 0.1
done
[[ -s "$OUT/port" ]] || { echo "Proxy failed to start" >&2; exit 1; }
PORT=$(<"$OUT/port")
rm "$OUT/port"

# Run Claude CLI through proxy (force OAuth by clearing API key)
echo "Running: claude -p 'say hi' --model $MODEL"
echo ""
ANTHROPIC_API_KEY= ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT \
  claude -p "say hi" --model "$MODEL" 2>/dev/null || true

echo ""
echo "=== Saved to $OUT/*-{headers,body}.json ==="
echo ""
echo "Inspect with:"
echo "  cat $OUT/1-headers.json | python3 -m json.tool"
echo "  python3 -c \"import json; d=json.load(open('$OUT/1-body.json')); print(sorted(d.keys()))\""
