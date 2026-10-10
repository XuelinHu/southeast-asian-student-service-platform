const { createServer, request } = require('node:http');

function createWebServer(apiPort) {
  return createServer((incoming, outgoing) => {
    const upstream = request({
      hostname: '127.0.0.1',
      port: apiPort,
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: '后端服务暂不可用' }));
      } else {
        outgoing.destroy();
      }
    });
    incoming.on('aborted', () => upstream.destroy());
    outgoing.on('close', () => {
      if (!outgoing.writableEnded) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
}

module.exports = { createWebServer };
