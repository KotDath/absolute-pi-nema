import { EventEmitter } from "node:events";

export function createExtensionHarness(options?: { cwd?: string }) {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const notifications: Array<{ msg: string; type?: string }> = [];
	const statusMap = new Map<string, unknown>();
	const entries: any[] = [];
	const eventBus = new EventEmitter();
	let activeTools = ["read", "write", "edit", "bash", "list_directory", "grep_search", "glob"];
	let nextId = 1;

	const ctx: any = {
		cwd: options?.cwd ?? process.cwd(),
		hasUI: true,
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => "leaf-1",
			getSessionFile: () => undefined,
		},
		ui: {
			notify(msg: string, type?: string) {
				notifications.push({ msg, type });
			},
			setStatus(key: string, value: unknown) {
				if (value === undefined) {
					statusMap.delete(key);
					return;
				}
				statusMap.set(key, value);
			},
			select: async () => null,
			confirm: async () => true,
			input: async () => null,
		},
	};

	const pi: any = {
		events: {
			on(event: string, handler: (...args: any[]) => any) {
				eventBus.on(event, handler);
			},
			emit(event: string, ...args: any[]) {
				eventBus.emit(event, ...args);
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
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerShortcut(name: string, shortcut: any) {
			shortcuts.set(name, shortcut);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({
				id: `entry-${nextId++}`,
				type: "custom",
				customType,
				data,
			});
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(nextTools: string[]) {
			activeTools = [...nextTools];
		},
	};

	return {
		pi,
		ctx,
		tools,
		commands,
		shortcuts,
		entries,
		notifications,
		statusMap,
		getActiveTools: () => [...activeTools],
		async emitAsync(event: string, ...args: any[]) {
			const results = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(...args));
			}
			return results;
		},
	};
}

