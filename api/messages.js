// Edge runtime gives us native fetch + ReadableStream, which we need for
// streaming translation without buffering the whole response.
export const config = { runtime: 'edge' };

// ============================================================================
// Configuration & Setup
// ============================================================================

const VERSION = '1.1.0';
const DEPLOYMENT_ENV = process.env.VERCEL_ENV || 'development';
const REQUEST_ID_PREFIX = 'req_';

// --- Upstream Provider Configuration ---
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_BEDROCK_API_KEY = process.env.AWS_BEDROCK_API_KEY;

const UPSTREAM_URL =
  (OPENAI_BASE_URL ? `${OPENAI_BASE_URL}/chat/completions` : null) ||
  `https://bedrock-runtime.${AWS_REGION}.amazonaws.com/openai/v1/chat/completions`;
const UPSTREAM_KEY = OPENAI_API_KEY || AWS_BEDROCK_API_KEY;

// --- Model Resolution ---
const DEFAULT_MODEL_ID = process.env.DEFAULT_MODEL_ID || process.env.BEDROCK_MODEL_ID || '';
let MODEL_MAP = {};
try {
  MODEL_MAP = process.env.MODEL_MAP ? JSON.parse(process.env.MODEL_MAP) : {};
} catch (err) {
  console.error('Failed to parse MODEL_MAP:', err.message);
  MODEL_MAP = {};
}

// --- Security ---
const PROXY_SECRET = process.env.PROXY_SECRET;
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === 'true';
const MAX_REQUEST_SIZE = 1024 * 1024; // 1MB

// ============================================================================
// Utilities
// ============================================================================

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

function resolveModel(requestedModel) {
  if (requestedModel && MODEL_MAP[requestedModel]) {
    return MODEL_MAP[requestedModel];
  }
  if (requestedModel) return requestedModel;
  return DEFAULT_MODEL_ID;
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

// ============================================================================
// Request Translation: Anthropic → OpenAI
// ============================================================================

function toOpenAIMessages(system, messages) {
  const out = [];

  if (system) {
    const text = Array.isArray(system)
      ? system.map((b) => b.text || '').join('\n')
      : system;
    if (text) out.push({ role: 'system', content: text });
  }

  for (const m of messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const toolCalls = [];
    const textParts = [];

    for (const block of m.content || []) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      } else if (block.type === 'tool_result') {
        // Anthropic represents a tool result as a block inside a "user"
        // message; OpenAI wants it as its own "tool" role message.
        const content =
          typeof block.content === 'string'
            ? block.content
            : (block.content || []).map((c) => c.text || '').join('\n');
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content,
        });
      } else if (block.type === 'image') {
        // GLM's Bedrock endpoint may not accept Anthropic-style image
        // blocks, so we drop them rather than send a malformed request.
        textParts.push('[image omitted: not supported by this proxy]');
      }
    }

    if (toolCalls.length) {
      out.push({
        role: 'assistant',
        content: textParts.join('\n') || null,
        tool_calls: toolCalls,
      });
    } else if (textParts.length) {
      out.push({ role: m.role, content: textParts.join('\n') });
    }
  }

  return out;
}

function toOpenAITools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function toOpenAIToolChoice(tool_choice) {
  if (!tool_choice) return undefined;
  if (tool_choice.type === 'auto') return 'auto';
  if (tool_choice.type === 'any') return 'required';
  if (tool_choice.type === 'tool') {
    return { type: 'function', function: { name: tool_choice.name } };
  }
  return undefined;
}

function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

// ============================================================================
// Response Translation: OpenAI → Anthropic
// ============================================================================

function fromOpenAICompletion(completion, modelName) {
  const choice = completion.choices?.[0];
  const msg = choice?.message || {};
  const content = [];

  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch (_) {
        // leave input as {} if the model produced invalid JSON
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    id: completion.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: modelName,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

// ============================================================================
// Stream Translation: OpenAI SSE → Anthropic SSE
// ============================================================================

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamTranslate(upstream, modelName, requestId) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  const messageId = `msg_${Date.now()}`;
  let textBlockOpen = false;
  let blockIndex = 0;
  const toolBlocks = {}; // openai tool-call index -> { blockIndex, id, name }
  let outputTokens = 0;
  let finishReason = null;
  let chunkCount = 0;

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          sseEvent('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: modelName,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })
        )
      );

      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep the trailing partial line for next read

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;

            let chunk;
            try {
              chunk = JSON.parse(payload);
            } catch (_) {
              continue;
            }

            chunkCount += 1;

            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};

            if (delta.content) {
              if (!textBlockOpen) {
                controller.enqueue(
                  encoder.encode(
                    sseEvent('content_block_start', {
                      type: 'content_block_start',
                      index: blockIndex,
                      content_block: { type: 'text', text: '' },
                    })
                  )
                );
                textBlockOpen = true;
              }
              controller.enqueue(
                encoder.encode(
                  sseEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: delta.content },
                  })
                )
              );
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolBlocks[idx]) {
                  if (textBlockOpen) {
                    controller.enqueue(
                      encoder.encode(
                        sseEvent('content_block_stop', {
                          type: 'content_block_stop',
                          index: blockIndex,
                        })
                      )
                    );
                    textBlockOpen = false;
                    blockIndex += 1;
                  }
                  toolBlocks[idx] = {
                    blockIndex,
                    id: tc.id || `tool_${idx}_${Date.now()}`,
                    name: tc.function?.name || '',
                  };
                  controller.enqueue(
                    encoder.encode(
                      sseEvent('content_block_start', {
                        type: 'content_block_start',
                        index: toolBlocks[idx].blockIndex,
                        content_block: {
                          type: 'tool_use',
                          id: toolBlocks[idx].id,
                          name: toolBlocks[idx].name,
                          input: {},
                        },
                      })
                    )
                  );
                  blockIndex += 1;
                }
                if (tc.function?.arguments) {
                  controller.enqueue(
                    encoder.encode(
                      sseEvent('content_block_delta', {
                        type: 'content_block_delta',
                        index: toolBlocks[idx].blockIndex,
                        delta: {
                          type: 'input_json_delta',
                          partial_json: tc.function.arguments,
                        },
                      })
                    )
                  );
                }
              }
            }

            if (choice.finish_reason) finishReason = choice.finish_reason;
            if (chunk.usage?.completion_tokens) {
              outputTokens = chunk.usage.completion_tokens;
            }
          }
        }
      } catch (err) {
        log(requestId, 'error', 'Stream processing error', {
          error: err.message,
          chunksProcessed: chunkCount,
        });
        // fall through and close cleanly even if the upstream connection dropped
      }

      if (textBlockOpen) {
        controller.enqueue(
          encoder.encode(
            sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: blockIndex,
            })
          )
        );
      }
      for (const idx of Object.keys(toolBlocks)) {
        controller.enqueue(
          encoder.encode(
            sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: toolBlocks[idx].blockIndex,
            })
          )
        );
      }

      controller.enqueue(
        encoder.encode(
          sseEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
            usage: { output_tokens: outputTokens },
          })
        )
      );
      controller.enqueue(
        encoder.encode(sseEvent('message_stop', { type: 'message_stop' }))
      );
      
      log(requestId, 'info', 'Streaming response complete', {
        chunksProcessed: chunkCount,
        outputTokens,
        finishReason,
      });
      
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-request-id': requestId,
    },
  });
}

// ============================================================================
// Main Handler
// ============================================================================

export default async function handler(req) {
  const requestId = generateRequestId();
  const startTime = Date.now();

  log(requestId, 'info', 'Incoming request', {
    method: req.method,
    url: req.url,
    timestamp: new Date().toISOString(),
  });

  // ---- Validate HTTP Method ----
  if (req.method !== 'POST') {
    log(requestId, 'error', 'Invalid HTTP method', { method: req.method });
    return jsonError(
      405,
      'invalid_request_error',
      'Only POST is supported',
      requestId
    );
  }

  // ---- Authenticate (if configured) ----
  if (PROXY_SECRET) {
    const key = req.headers.get('x-api-key');
    if (key !== PROXY_SECRET) {
      log(requestId, 'error', 'Authentication failed', { provided: !!key });
      return jsonError(
        401,
        'authentication_error',
        'Invalid or missing x-api-key header',
        requestId
      );
    }
  }

  // ---- Validate Upstream Configuration ----
  if (!UPSTREAM_KEY) {
    log(requestId, 'error', 'Missing upstream credentials');
    return jsonError(
      500,
      'api_error',
      'Proxy not configured: Set OPENAI_API_KEY (preferred) or AWS_BEDROCK_API_KEY',
      requestId
    );
  }

  // ---- Parse Request Body ----
  let body;
  let contentLength = 0;
  try {
    const bodyText = await req.text();
    contentLength = bodyText.length;

    if (contentLength > MAX_REQUEST_SIZE) {
      log(requestId, 'error', 'Request body too large', {
        size: contentLength,
        max: MAX_REQUEST_SIZE,
      });
      return jsonError(
        413,
        'invalid_request_error',
        `Request body exceeds ${MAX_REQUEST_SIZE / 1024 / 1024}MB limit`,
        requestId
      );
    }

    body = JSON.parse(bodyText);
  } catch (err) {
    log(requestId, 'error', 'Failed to parse request body', {
      error: err.message,
    });
    return jsonError(
      400,
      'invalid_request_error',
      'Invalid JSON body: ' + err.message,
      requestId
    );
  }

  // ---- Extract & Validate Request Parameters ----
  const {
    model,
    messages = [],
    system,
    max_tokens,
    temperature,
    top_p,
    stop_sequences,
    stream,
    tools,
    tool_choice,
  } = body;

  // Validate required fields
  if (!Array.isArray(messages)) {
    log(requestId, 'error', 'Invalid messages field', {
      type: typeof messages,
    });
    return jsonError(
      400,
      'invalid_request_error',
      'messages must be an array',
      requestId
    );
  }

  if (max_tokens !== undefined && (typeof max_tokens !== 'number' || max_tokens < 1)) {
    log(requestId, 'error', 'Invalid max_tokens', { value: max_tokens });
    return jsonError(
      400,
      'invalid_request_error',
      'max_tokens must be a positive integer',
      requestId
    );
  }

  // Resolve model
  const resolvedModel = resolveModel(model);
  if (!resolvedModel) {
    log(requestId, 'error', 'No model resolved', {
      requested: model,
      defaultAvailable: !!DEFAULT_MODEL_ID,
      modelMapSize: Object.keys(MODEL_MAP).length,
    });
    return jsonError(
      400,
      'invalid_request_error',
      'No model specified and no DEFAULT_MODEL_ID configured. Set ANTHROPIC_MODEL on client or DEFAULT_MODEL_ID on proxy.',
      requestId
    );
  }

  log(requestId, 'info', 'Model resolved', {
    requested: model,
    resolved: resolvedModel,
    stream: !!stream,
  });

  // ---- Build OpenAI Request ----
  const openaiBody = {
    model: resolvedModel,
    messages: toOpenAIMessages(system, messages),
    stream: !!stream,
  };
  // OpenAI's reasoning-family models (o1, o3, gpt-5.x) reject the legacy
  // `max_tokens` field with a 400 and require `max_completion_tokens`
  // instead. Detect by model id prefix/substring so both old- and
  // new-style providers work without manual config.
  const usesMaxCompletionTokens = /(^|[./])(o[13]|gpt-5)/i.test(resolvedModel);
  if (max_tokens !== undefined) {
    if (usesMaxCompletionTokens) {
      openaiBody.max_completion_tokens = max_tokens;
    } else {
      openaiBody.max_tokens = max_tokens;
    }
  }
  if (temperature !== undefined) openaiBody.temperature = temperature;
  if (top_p !== undefined) openaiBody.top_p = top_p;
  if (stop_sequences?.length) openaiBody.stop = stop_sequences;

  const openaiTools = toOpenAITools(tools);
  if (openaiTools) openaiBody.tools = openaiTools;

  const openaiToolChoice = toOpenAIToolChoice(tool_choice);
  if (openaiToolChoice) openaiBody.tool_choice = openaiToolChoice;

  // ---- Call Upstream Provider ----
  let upstream;
  const upstreamStartTime = Date.now();
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${UPSTREAM_KEY}`,
        'user-agent': `claude-bedrock-proxy/${VERSION}`,
      },
      body: JSON.stringify(openaiBody),
    });
    const upstreamDuration = Date.now() - upstreamStartTime;
    log(requestId, 'info', 'Upstream request completed', {
      status: upstream.status,
      duration: upstreamDuration,
    });
  } catch (err) {
    const upstreamDuration = Date.now() - upstreamStartTime;
    log(requestId, 'error', 'Failed to reach upstream', {
      error: err.message,
      duration: upstreamDuration,
    });
    return jsonError(
      502,
      'api_error',
      `Failed to reach upstream provider: ${err.message}`,
      requestId
    );
  }

  // ---- Handle Upstream Errors ----
  if (!upstream.ok) {
    const errText = await upstream.text();
    log(requestId, 'error', 'Upstream error', {
      status: upstream.status,
      model: resolvedModel,
      errorPreview: errText.substring(0, 200),
    });
    return jsonError(
      upstream.status,
      'api_error',
      `Upstream provider (${resolvedModel}) returned ${upstream.status}: ${errText.substring(0, 500)}`,
      requestId
    );
  }

  // ---- Return Response (Streaming or Non-Streaming) ----
  if (!stream) {
    const completion = await upstream.json();
    const anthropicResponse = fromOpenAICompletion(completion, resolvedModel);
    const totalDuration = Date.now() - startTime;
    log(requestId, 'info', 'Non-streaming response complete', {
      duration: totalDuration,
      inputTokens: anthropicResponse.usage?.input_tokens,
      outputTokens: anthropicResponse.usage?.output_tokens,
    });
    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
        'x-response-time': totalDuration.toString(),
      },
    });
  }

  log(requestId, 'info', 'Starting streaming response');
  return streamTranslate(upstream, resolvedModel, requestId);
}