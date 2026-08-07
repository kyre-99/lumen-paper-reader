// 单次 /api/chat 请求内多次模型调用的 token 累计器
export type TokenMeter = { prompt: number; completion: number };

export function addUsage(meter: TokenMeter | undefined, usage: unknown) {
  if (!meter || !usage || typeof usage !== "object") return;
  const tokens = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  meter.prompt += Number(tokens.prompt_tokens) || 0;
  meter.completion += Number(tokens.completion_tokens) || 0;
}

export async function complete(target: URL, apiKey: string, payload: Record<string, unknown>, meter?: TokenMeter): Promise<string> {
  const response = await fetch(target.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ...payload, stream: false }),
  });
  const data = await response.json().catch(() => ({})) as { error?: { message?: string }; choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
  if (!response.ok) throw new Error(data?.error?.message || `模型接口返回 ${response.status}`);
  addUsage(meter, data.usage);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("模型没有返回可读取的内容");
  return content;
}

export async function* streamCompletion(target: URL, apiKey: string, payload: Record<string, unknown>, meter?: TokenMeter): AsyncGenerator<string> {
  const post = (body: Record<string, unknown>) => fetch(target.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  // include_usage 让流式响应在末尾携带 token 统计；部分兼容端点不支持该参数时退回普通流式请求
  let response = await post({ ...payload, stream: true, stream_options: { include_usage: true } });
  if (!response.ok || !response.body) response = await post({ ...payload, stream: true });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(data?.error?.message || `模型接口返回 ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data);
        addUsage(meter, chunk?.usage);
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      } catch { /* 忽略不完整的分片 */ }
    }
  }
}
