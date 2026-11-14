import { HttpError } from '../http.js';

const invalidOutput = () => new HttpError(502, 'INVALID_ASSISTANT_OUTPUT', 'Split could not interpret that safely. Try again or enter the expense manually.');
const unavailable = () => new HttpError(503, 'ASSISTANT_UNAVAILABLE', 'Split is temporarily unavailable. Try again or enter the expense manually.');

async function decodeResponse(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 64 * 1024) throw invalidOutput();
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalidOutput(); }
  if (value?.promptFeedback?.blockReason || !Array.isArray(value?.candidates) || value.candidates.length !== 1) throw invalidOutput();
  const candidate = value.candidates[0];
  const parts = candidate?.content?.parts;
  if (candidate?.finishReason !== 'STOP' || !Array.isArray(parts) || !parts.length) throw invalidOutput();
  // Never dispatch a function call or return prose/HTML from the model.
  if (parts.some((part) => typeof part?.text !== 'string' || part.functionCall || part.functionResponse || part.inlineData || part.fileData)) {
    throw invalidOutput();
  }
  const text = parts.filter((part) => part.thought !== true).map((part) => part.text).join('');
  let output;
  try { output = JSON.parse(text); } catch { throw invalidOutput(); }
  return output;
}

export function createGeminiClient({ apiKey, model, fetchImpl = fetch, timeoutMs = 25_000, now = Date.now }) {
  let active = 0;
  let windowStart = now();
  let requests = 0;
  return async ({ instructions, input, schema }) => {
    if (!apiKey?.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model || '')) {
      throw new HttpError(503, 'ASSISTANT_NOT_CONFIGURED', 'Split is not available yet. Enter the expense manually.');
    }
    if (now() - windowStart >= 60_000) { windowStart = now(); requests = 0; }
    // Bound paid-provider use across this demo process. Do not queue messages
    // or automatically retry: retries cost money and must remain user-driven.
    if (active >= 4 || requests >= 30) {
      throw new HttpError(503, 'ASSISTANT_BUSY', 'Split is busy. Try again in a minute.');
    }
    active++;
    requests++;
    try {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
          generationConfig: {
            maxOutputTokens: 2048,
            candidateCount: 1,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            // This task needs extraction/classification, not extended reasoning.
            // Other configured models retain their own supported defaults.
            ...(model === 'gemini-3.5-flash' ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
          },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw unavailable();
      }
      return await decodeResponse(response);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new HttpError(504, 'ASSISTANT_TIMEOUT', 'Split took too long to respond. Try again or enter the expense manually.');
      }
      // Do not expose provider bodies, URLs containing credentials, or prompts.
      throw unavailable();
    } finally {
      active--;
    }
  };
}
