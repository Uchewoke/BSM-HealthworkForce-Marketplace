import Anthropic from '@anthropic-ai/sdk';

/** One read-only capability the assistant may use. `run` is server code bound to the signed-in user's organization. */
export interface AssistantTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input (type: object). The tool still validates its own input: the model is not trusted. */
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: false };
  run(input: unknown): Promise<unknown>;
}

export interface AssistantTurn {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tools: AssistantTool[];
}

export interface AssistantResult {
  reply: string;
  toolsUsed: string[];
  usage: { inputTokens: number; outputTokens: number };
  /** The model declined (safety policy). `reply` then holds a plain explanation, never model text. */
  refused: boolean;
  /** The conversation hit a step or length limit before the model finished. */
  incomplete: boolean;
}

export interface AssistantProvider {
  /** False until credentials exist. Nothing is simulated when it is false. */
  readonly configured: boolean;
  run(turn: AssistantTurn): Promise<AssistantResult>;
}

/** Used until an API key is set. The product says so; it never produces a pretend answer. */
export class NotConfiguredAssistant implements AssistantProvider {
  readonly configured = false;
  async run(): Promise<AssistantResult> { throw new Error('The AI assistant is not configured.'); }
}

type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
export type CreateMessage = (params: CreateParams) => Promise<Anthropic.Beta.BetaMessage>;

export const DEFAULT_ASSISTANT_MODEL = 'claude-opus-5-5';
export const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_RESULT_CHARS = 20_000;
const REFUSAL_REPLY = 'I can’t help with that request. Try rephrasing it, or ask about your staffing data instead.';
const INCOMPLETE_REPLY = 'I couldn’t finish working that out. Please ask a narrower question.';

export interface AnthropicAssistantOptions {
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  /** Defaults to true for Opus 5.x models, which can be declined by safeguards; the API then retries on a fallback model. */
  serverFallbacks?: boolean;
  maxTokens?: number;
}

/** Calls Claude through the official SDK with a manual tool loop. Thinking blocks are passed back untouched between rounds. */
export class AnthropicAssistant implements AssistantProvider {
  readonly configured = true;
  private readonly model: string;
  private readonly effort: 'low' | 'medium' | 'high';
  private readonly fallbacks: boolean;
  private readonly maxTokens: number;

  constructor(private readonly create: CreateMessage, opts: AnthropicAssistantOptions = {}) {
    this.model = opts.model ?? DEFAULT_ASSISTANT_MODEL;
    this.effort = opts.effort ?? 'medium';
    this.fallbacks = opts.serverFallbacks ?? this.model.startsWith('claude-opus-5');
    this.maxTokens = opts.maxTokens ?? 16_000;
  }

  /** Reads credentials the SDK normally resolves (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN). Otherwise stays unconfigured. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AssistantProvider {
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return new NotConfiguredAssistant();
    const client = new Anthropic();
    const effort = env.ASSISTANT_EFFORT === 'low' || env.ASSISTANT_EFFORT === 'high' ? env.ASSISTANT_EFFORT : 'medium';
    return new AnthropicAssistant((p) => client.beta.messages.create(p), { model: env.ASSISTANT_MODEL || DEFAULT_ASSISTANT_MODEL, effort });
  }

  async run(turn: AssistantTurn): Promise<AssistantResult> {
    const messages: Anthropic.Beta.BetaMessageParam[] = turn.messages.map((m) => ({ role: m.role, content: m.content }));
    const tools = turn.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { ...t.inputSchema, additionalProperties: false as const } }));
    const byName = new Map(turn.tools.map((t) => [t.name, t]));
    const toolsUsed: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const res = await this.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: turn.system,
        messages,
        tools,
        output_config: { effort: this.effort },
        ...(this.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      usage.inputTokens += res.usage.input_tokens;
      usage.outputTokens += res.usage.output_tokens;

      if (res.stop_reason === 'refusal') return { reply: REFUSAL_REPLY, toolsUsed, usage, refused: true, incomplete: false };
      const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (res.stop_reason === 'end_turn' || res.stop_reason === 'stop_sequence') return { reply: text, toolsUsed, usage, refused: false, incomplete: false };
      if (res.stop_reason === 'max_tokens') return { reply: text || INCOMPLETE_REPLY, toolsUsed, usage, refused: false, incomplete: true };

      if (res.stop_reason !== 'tool_use' && res.stop_reason !== 'pause_turn') return { reply: text || INCOMPLETE_REPLY, toolsUsed, usage, refused: false, incomplete: true };
      // Keep the whole assistant turn (including thinking blocks) exactly as returned, then answer every tool call in ONE user message.
      messages.push({ role: 'assistant', content: res.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        const tool = byName.get(block.name);
        toolsUsed.push(block.name);
        if (!tool) { results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: `Unknown tool: ${block.name}` }); continue; }
        try {
          const out = JSON.stringify(await tool.run(block.input));
          results.push({ type: 'tool_result', tool_use_id: block.id, content: out.length > MAX_TOOL_RESULT_CHARS ? `${out.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]` : out });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: e instanceof Error ? e.message : 'The tool failed.' });
        }
      }
      if (results.length) messages.push({ role: 'user', content: results });
    }
    return { reply: INCOMPLETE_REPLY, toolsUsed, usage, refused: false, incomplete: true };
  }
}
