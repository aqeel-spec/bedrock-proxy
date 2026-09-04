import http from 'node:http';
import messagesHandler from './api/messages.js';
import countTokensHandler from './api/count_tokens.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_SIZE = 1024 * 1024;

async function readBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      throw new Error('Request body exceeds 1MB limit');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function toWebRequest(request, body) {
  const protocol = request.socket.encrypted ? 'https' : 'http';
  const host = request.headers.host || `${HOST}:${PORT}`;
  return new Request(`${protocol}://${host}${request.url}`, {
    method: request.method,
    headers: request.headers,
    body: body.length ? body : undefined,
  });
}

async function sendWebResponse(response, nodeResponse) {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, key) => nodeResponse.setHeader(key, value));

  if (!response.body) {
    nodeResponse.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeResponse.write(Buffer.from(value));
    }
  } finally {
    nodeResponse.end();
  }
}

function sendError(nodeResponse, status, message) {
  nodeResponse.writeHead(status, { 'content-type': 'application/json' });
  nodeResponse.end(JSON.stringify({ error: message }));
}

const server = http.createServer(async (request, nodeResponse) => {
  const route = request.url?.split('?')[0];
  const handler =
    route === '/v1/messages'
      ? messagesHandler
      : route === '/v1/messages/count_tokens'
        ? countTokensHandler
        : null;

  if (!handler) {
    sendError(nodeResponse, 404, 'Not found');
    return;
  }

  try {
    const body = request.method === 'POST' ? await readBody(request) : Buffer.alloc(0);
    const response = await handler(toWebRequest(request, body));
    await sendWebResponse(response, nodeResponse);
  } catch (error) {
    const status = error.message.includes('1MB') ? 413 : 500;
    sendError(nodeResponse, status, error.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude proxy listening at http://${HOST}:${PORT}`);
  console.log('Endpoints: POST /v1/messages and POST /v1/messages/count_tokens');
});