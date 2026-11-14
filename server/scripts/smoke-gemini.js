import { checkGemini } from '../assistant/gemini-smoke.js';

try {
  const result = await checkGemini({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
