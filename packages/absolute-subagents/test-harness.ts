import { EventEmitter } from "node:events";

export function createExtensionHarness(options?: { cwd?: string }) {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const emittedEvents: Array<{ name: string; payload: unknown }> = [];
	const eventBus = new EventEmitter();

	const ctx: any = {
		cwd: options?.cwd ?? process.cwd(),
		hasUI: true,
		sessionManager: {
			getEntries: () => entries,
		},
		ui: {
			notify() {},
		},
	};

	const pi: any = {
		events: {
			on(event: string, handler: (...args: any[]) => any) {
				eventBus.on(event, handler);
			},
			emit(name: string, payload: unknown) {
				emittedEvents.push({ name, payload });
				eventBus.emit(name, payload);
			},
		},
		on(event: string, handler: (...args: any[]) => any) {
			if (!handlers.has(event)) {
				handlers.set(event, []);
			}
			handlers.get(event)?.push(handler);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ id: `entry-${entries.length + 1}`, type: "custom", customType: type, data });
		},
	};

	return {
		pi,
		ctx,
		tools,
		entries,
		emittedEvents,
		async emitAsync(event: string, ...args: any[]) {
			const results = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(...args));
			}
			return results;
		},
	};
}

