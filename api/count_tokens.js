// Token counting endpoint: rough character-based estimate
// Claude Code calls /v1/messages/count_tokens to estimate input usage before sending full requests.
// Most OpenAI-compatible providers don't have a token counting endpoint, so this returns
// a rough estimate based on character count (~1 token ≈ 4 chars). Accurate within ~10-15%.
// It's good enough to avoid errors and prevent token limit surprises.

export const config = { runtime: 'edge' };

const ENABLE_LOGGING = process.env.ENABLE_LOGGING === 'true';
const PROXY_SECRET = process.env.PROXY_SECRET;
const REQUEST_ID_PREFIX = 'req_';

function generateRequestId() {
  return REQUEST_ID_PREFIX + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function log(requestId, level, message, data = null) {
  if (!ENABLE_LOGGING && level !== 'error') return;
  const timestamp = new Date().toISOString();
  const entry = { timestamp, requestId, level, message };
  if (data) entry.data = data;
  console.log(JSON.stringify(entry));
}

function jsonError(status, type, message, requestId = null) {
  const error = {
    type: 'error',
    error: { type, message },
  };
  if (requestId) error.request_id = requestId;
  return new Response(JSON.stringify(error), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(req) {
  const requestId = generateRequestId();

  // Validate HTTP method
  if (req.method !== 'POST') {
    log(requestId, 'error', 'Invalid HTTP method', { method: req.method });
    return jsonError(
      405,
      'invalid_request_error',
      'Only POST is supported',
      requestId
    );
  }

  // Authenticate (if configured)
  if (PROXY_SECRET) {
    const key = req.headers.get('x-api-key');
    if (key !== PROXY_SECRET) {
      log(requestId, 'error', 'Authentication failed');
      return jsonError(
        401,
        'authentication_error',
        'Invalid or missing x-api-key header',
        requestId
      );
    }
  }

  // Parse request body
  let body;
  try {
    body = await req.json();
  } catch (err) {
    log(requestId, 'error', 'Failed to parse request body', { error: err.message });
    return jsonError(
      400,
      'invalid_request_error',
      'Invalid JSON body: ' + err.message,
      requestId
    );
  }

  // Estimate token count: rough character-based calculation
  // This mimics Anthropic's token counting approach
  try {
    const messagesText = JSON.stringify(body.messages || []);
    const systemText = JSON.stringify(body.system || '');
    const totalText = messagesText + systemText;

    // Rough estimate: 1 token ≈ 4 characters
    // Add a small buffer for encoding overhead
    const estimate = Math.max(1, Math.ceil(totalText.length / 4 * 1.05));

    log(requestId, 'info', 'Token count estimated', {
      textLength: totalText.length,
      estimatedTokens: estimate,
    });

    return new Response(JSON.stringify({ input_tokens: estimate }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
    });
  } catch (err) {
    log(requestId, 'error', 'Token counting error', { error: err.message });
    return jsonError(
      400,
      'invalid_request_error',
      'Failed to count tokens: ' + err.message,
      requestId
    );
  }
}
