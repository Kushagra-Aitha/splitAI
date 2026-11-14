export async function checkGemini({ apiKey, model, fetchImpl = fetch, timeoutMs = 15_000 }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required for the live smoke check.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model || '')) {
    throw new Error('GEMINI_MODEL must be a model name, without a URL or models/ prefix.');
  }
  let response;
  try {
    response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with exactly SPLIT_AI_OK and no other text.' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256 },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gemini smoke check failed (HTTP ${response.status}).`);
    }
    // Bound provider output before parsing. The smoke request contains no user
    // data and the raw response is never printed or exposed by an API route.
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error('Gemini smoke response was too large.');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.filter((part) => !part.thought).map((part) => part.text || '').join('').trim();
    if (candidate?.finishReason !== 'STOP' || text !== 'SPLIT_AI_OK') {
      throw new Error('Gemini did not return the expected smoke-check response.');
    }
    return { status: 'ok', model };
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('Gemini smoke check timed out.');
    if (error.message.startsWith('Gemini ')) throw error;
    throw new Error('Gemini smoke check failed. Check network access and provider configuration.');
  }
}
