import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type AssistantMessageLike = {
	role?: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
};

type RetrySettings = {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
};

const PATCHED = Symbol.for("pi.openrouter-free-rate-limit-resilience.patched");
const UNLIMITED_RETRIES = Number.MAX_SAFE_INTEGER;
let openRouterFreeRequestQueue: Promise<void> = Promise.resolve();
let lastOpenRouterFreeRequestCompletedAt = 0;

function isOpenRouterFreeRateLimitText(text: string): boolean {
	return (
		/(?:429|rate.?limit|temporarily rate-limited upstream|Provider returned error)/i.test(text) &&
		/(?::free\b|is_byok"?:false|add your own key|openrouter\.ai\/settings\/integrations|temporarily rate-limited upstream)/i.test(text)
	);
}

function messageText(message: any): string {
	const parts: string[] = [];
	if (message?.provider) parts.push(String(message.provider));
	if (message?.model) parts.push(String(message.model));
	if (message?.errorMessage) parts.push(String(message.errorMessage));
	if (typeof message?.content === "string") parts.push(message.content);
	if (Array.isArray(message?.content)) {
		for (const item of message.content) {
			if (typeof item?.text === "string") parts.push(item.text);
		}
	}
	return parts.join("\n");
}

function isOpenRouterFreeRateLimit(message: AssistantMessageLike): boolean {
	const text = messageText(message);
	return (message.provider === "openrouter" || /openrouter/i.test(text)) && isOpenRouterFreeRateLimitText(text);
}

function isOpenRouterFreeRateLimitEvent(event: any): boolean {
	if (!event) return false;
	if (event.message && isOpenRouterFreeRateLimit(event.message)) return true;
	if (typeof event.errorMessage === "string" && isOpenRouterFreeRateLimitText(event.errorMessage)) return true;
	if (Array.isArray(event.messages)) {
		const lastAssistant = [...event.messages].reverse().find((m) => m?.role === "assistant");
		return lastAssistant ? isOpenRouterFreeRateLimit(lastAssistant) : false;
	}
	return false;
}

function effectiveMaxRetries(settings: RetrySettings, message: AssistantMessageLike): number {
	return isOpenRouterFreeRateLimit(message) ? UNLIMITED_RETRIES : settings.maxRetries;
}

function extractRetryAfterMs(errorMessage: string): number | undefined {
	const retryAfter = /retry(?:-after| after| in)?\s*:?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)/i.exec(errorMessage);
	if (!retryAfter) return undefined;

	const value = Number(retryAfter[1]);
	if (!Number.isFinite(value) || value <= 0) return undefined;

	const unit = retryAfter[2].toLowerCase();
	if (unit.startsWith("m") && unit !== "ms") return value * 60_000;
	if (unit === "ms" || unit.startsWith("millisecond")) return value;
	return value * 1000;
}

function retryDelayMs(settings: RetrySettings, attempt: number, message: AssistantMessageLike): number {
	const errorMessage = message.errorMessage || "";
	const exponentialDelay = settings.baseDelayMs * 2 ** Math.min(attempt - 1, 8);
	const retryAfterMs = extractRetryAfterMs(errorMessage) ?? 0;

	if (isOpenRouterFreeRateLimit(message)) {
		const freeModelDelay = Math.max(retryAfterMs, 15_000 * Math.min(attempt, 8), exponentialDelay);
		return Math.min(freeModelDelay, 120_000) + Math.floor(Math.random() * 5_000);
	}

	return Math.max(retryAfterMs, exponentialDelay) + Math.floor(Math.random() * 1_000);
}

function updateRateLimitUi(session: any): void {
	const ui = session?._extensionUIContext;
	ui?.setWidget?.("openrouter-free-retry", ["🚦 waiting for rate limit"]);
}

function clearRateLimitUi(session: any): void {
	const ui = session?._extensionUIContext;
	ui?.setWidget?.("openrouter-free-retry", undefined);
}

function sleepWithRateLimitUi(session: any, ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Retry cancelled"));
			return;
		}

		updateRateLimitUi(session);
		const interval = setInterval(() => updateRateLimitUi(session), 1000);
		const timer = setTimeout(() => {
			clearInterval(interval);
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(timer);
			clearInterval(interval);
			reject(new Error("Retry cancelled"));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Retry cancelled"));
			return;
		}

		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Retry cancelled"));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isOpenRouterFreeModel(model: unknown): boolean {
	return (
		typeof model === "object" &&
		model !== null &&
		(model as { provider?: unknown }).provider === "openrouter" &&
		typeof (model as { id?: unknown }).id === "string" &&
		(model as { id: string }).id.includes(":free")
	);
}

function isOpenRouterFreeAssistantMessage(message: any): boolean {
	return message?.role === "assistant" && message?.provider === "openrouter" && typeof message?.model === "string" && message.model.includes(":free");
}

function markOpenRouterFreeRequestCompleted(): void {
	lastOpenRouterFreeRequestCompletedAt = Date.now();
}

async function throttleOpenRouterFreeRequest(signal?: AbortSignal): Promise<void> {
	const run = async () => {
		if (lastOpenRouterFreeRequestCompletedAt <= 0) return;
		const waitMs = Math.max(0, lastOpenRouterFreeRequestCompletedAt + 5_000 - Date.now());
		if (waitMs > 0) await sleep(waitMs, signal);
	};

	const previous = openRouterFreeRequestQueue.catch(() => undefined);
	const next = previous.then(run);
	openRouterFreeRequestQueue = next.catch(() => undefined);
	await next;
}

function findPackageRoot(start: string): string | undefined {
	let current = dirname(start);
	while (true) {
		if (existsSync(join(current, "package.json"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function resolveAgentSessionUrl(): string {
	const roots = new Set<string>([
		process.argv[1] ? findPackageRoot(process.argv[1]) : undefined,
		join(process.env.HOME || "", ".local", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
	].filter((p): p is string => Boolean(p)));

	const agentSessionCandidates = [...roots].flatMap((root) => [
		join(root, "dist", "core", "agent-session.js"),
		join(root, "dist", "core", "agent-session.mjs"),
		join(root, "dist", "core", "agent-session.cjs"),
		join(root, "dist", "core", "agent-session", "index.js"),
	]);

	for (const candidate of agentSessionCandidates) {
		if (existsSync(candidate)) return pathToFileURL(candidate).href;
	}

	throw new Error(`Cannot resolve pi AgentSession file. Tried: ${agentSessionCandidates.join(", ") || "(no candidates)"}`);
}

async function patchAgentSession(): Promise<boolean> {
	const agentSessionUrl = resolveAgentSessionUrl();
	const { AgentSession } = await import(agentSessionUrl);
	const proto = AgentSession.prototype as any;

	const firstInstall = !proto[PATCHED];
	proto[PATCHED] = true;

	const originalEmit = proto._emit;
	proto._emit = function (event: any) {
		// Keep OpenRouter :free rate-limit retries completely quiet in the transcript/UI.
		// Only the small widget from this extension remains visible.
		if (event?.type === "message_end" && isOpenRouterFreeAssistantMessage(event.message)) {
			markOpenRouterFreeRequestCompleted();
		}
		if (
			(event?.type === "message_start" || event?.type === "message_update" || event?.type === "message_end") &&
			event.message?.role === "assistant" &&
			isOpenRouterFreeRateLimit(event.message)
		) {
			markOpenRouterFreeRequestCompleted();
			return;
		}
		if ((event?.type === "agent_end" || event?.type === "auto_retry_start" || event?.type === "auto_retry_end") && isOpenRouterFreeRateLimitEvent(event)) {
			return;
		}
		return originalEmit.call(this, event);
	};

	proto._willRetryAfterAgentEnd = function (event: { messages: AssistantMessageLike[] }) {
		const settings: RetrySettings = this.settingsManager.getRetrySettings();
		const message = [...event.messages].reverse().find((m) => m.role === "assistant");
		const maxRetries = message ? effectiveMaxRetries(settings, message) : settings.maxRetries;

		if (!settings.enabled || this._retryAttempt >= maxRetries) return false;
		return message ? this._isRetryableError(message) : false;
	};

	proto._prepareRetry = async function (message: AssistantMessageLike): Promise<boolean> {
		const settings: RetrySettings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) return false;

		this._retryAttempt++;
		const openRouterFreeRateLimit = isOpenRouterFreeRateLimit(message);
		const maxRetries = effectiveMaxRetries(settings, message);

		if (this._retryAttempt > maxRetries) {
			this._retryAttempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this._retryAttempt, message);

		if (!openRouterFreeRateLimit) {
			this._emit({
				type: "auto_retry_start",
				attempt: this._retryAttempt,
				maxAttempts: maxRetries,
				delayMs,
				errorMessage: message.errorMessage || "Unknown error",
			});
		}

		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		this._retryAbortController = new AbortController();
		try {
			if (openRouterFreeRateLimit) {
				await sleepWithRateLimitUi(this, delayMs, this._retryAbortController.signal);
			} else {
				await sleep(delayMs, this._retryAbortController.signal);
			}
		} catch {
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			if (openRouterFreeRateLimit) {
				clearRateLimitUi(this);
			} else {
				this._emit({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError: "Retry cancelled",
				});
			}
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	};

	return firstInstall;
}

export default async function (pi: ExtensionAPI) {
	await patchAgentSession();

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget("openrouter-free-retry", undefined);
	});

	pi.on("before_provider_request" as any, async (_event: any, ctx: any) => {
		if (isOpenRouterFreeModel(ctx.model)) {
			await throttleOpenRouterFreeRequest(ctx.signal);
		}
	});

	pi.on("message_end" as any, async (event: any, ctx) => {
		if (isOpenRouterFreeAssistantMessage(event.message)) {
			markOpenRouterFreeRequestCompleted();
		}
		if (event.message?.role === "assistant" && event.message.stopReason !== "error") {
			ctx.ui.setWidget("openrouter-free-retry", undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget("openrouter-free-retry", undefined);
	});

	pi.registerCommand("openrouter-retry-resilience", {
		description: "Show OpenRouter free-model retry resilience status",
		handler: async (_args, ctx) => {
			ctx.ui.notify("OpenRouter :free 429 resilience is active: unlimited silent retries; rate limits show only: 🚦 waiting for rate limit", "info");
		},
	});
}
