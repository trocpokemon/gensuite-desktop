// Lists the LLM models the GenSuite paid API exposes for script generation.
// Calls GET /v1/models (public Developer API) and returns the `scriptModels`
// group. Used by the Bước 2 model picker so the app offers every model the API
// supports (Claude, Gemini, GPT, DeepSeek, …) instead of a single hardcoded id.
const BASE_URL = 'https://api.gensuite.site/v1';

export interface ScriptModel {
  id: string;
  name: string;
  provider: string;
  inputCreditsPerK: number;
  outputCreditsPerK: number;
}

export async function listScriptModels(apiKey: string): Promise<ScriptModel[]> {
  if (!apiKey?.trim()) throw new Error('MISSING_KEY:gensuite');
  const resp = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => null as any);
    const code = String(data?.error ?? '');
    if (resp.status === 401 || resp.status === 403 || code === 'INVALID_API_KEY') throw new Error('MISSING_KEY:gensuite');
    throw new Error(`GenSuite lỗi ${resp.status}: ${String(data?.message ?? code ?? 'không tải được model')}`.slice(0, 300));
  }
  const data = await resp.json().catch(() => null as any);
  const rows = Array.isArray(data?.scriptModels) ? data.scriptModels : [];
  return rows
    .map((row: any): ScriptModel => ({
      id: String(row?.id ?? ''),
      name: String(row?.name ?? row?.id ?? ''),
      provider: String(row?.provider ?? ''),
      inputCreditsPerK: Number(row?.inputCreditsPerK ?? 0),
      outputCreditsPerK: Number(row?.outputCreditsPerK ?? 0),
    }))
    .filter((row: ScriptModel) => row.id);
}
