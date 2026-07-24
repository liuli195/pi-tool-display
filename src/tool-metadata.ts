const MCP_DESCRIPTION_PATTERN = /\bmcp\b/i;
const MCP_ADAPTER_SOURCE_PATTERN = /(?:^|[/\\@_-])(?:pi-)?mcp(?:[/\\@_-]|$)|pi-mcp-adapter|mcp-adapter/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		return {};
	}

	return value;
}

export function getTextField(value: unknown, field: string): string | undefined {
	const record = toRecord(value);
	const raw = record[field];
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function hasMcpSourceInfo(value: unknown): boolean {
	const sourceInfo = toRecord(value);
	for (const [key, raw] of Object.entries(sourceInfo)) {
		if (typeof raw !== "string" || raw.trim().length === 0) {
			continue;
		}

		const normalizedKey = key.toLowerCase();
		const normalizedValue = raw.trim();
		if (["source", "type", "kind", "origin"].includes(normalizedKey) && normalizedValue.toLowerCase() === "mcp") {
			return true;
		}
		if (MCP_ADAPTER_SOURCE_PATTERN.test(normalizedValue)) {
			return true;
		}
	}

	return false;
}

export function isMcpToolCandidate(tool: unknown): boolean {
	if (!tool || typeof tool !== "object") {
		return false;
	}

	const record = tool as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name : "";
	const description = typeof record.description === "string" ? record.description : "";
	const label = typeof record.label === "string" ? record.label : "";

	if (name === "mcp") {
		return true;
	}
	if (MCP_DESCRIPTION_PATTERN.test(description) || MCP_DESCRIPTION_PATTERN.test(label)) {
		return true;
	}
	if (hasMcpSourceInfo(record.sourceInfo)) {
		return true;
	}
	if (/^mcp[_-]/i.test(name) || /_mcp$/i.test(name)) {
		return true;
	}
	if (name.includes(":")) {
		return true;
	}
	if (/^ctx_/i.test(name)) {
		return true;
	}

	const params = record.parameters;
	if (params && typeof params === "object") {
		const parameterRecord = params as Record<string, unknown>;
		if (
			"mcpServer" in parameterRecord ||
			"serverUrl" in parameterRecord ||
			"server_name" in parameterRecord
		) {
			return true;
		}
	}

	return false;
}
