import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeUrlError";
	}
}

function ipv4ToNumber(address: string) {
	const parts = address.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return undefined;
	}
	return parts.reduce((sum, part) => (sum << 8) + part, 0) >>> 0;
}

function ipv4InRange(address: string, base: string, bits: number) {
	const value = ipv4ToNumber(address);
	const baseValue = ipv4ToNumber(base);
	if (value === undefined || baseValue === undefined) {
		return false;
	}
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) === (baseValue & mask);
}

function isUnsafeIpv4(address: string) {
	return (
		ipv4InRange(address, "0.0.0.0", 8) ||
		ipv4InRange(address, "10.0.0.0", 8) ||
		ipv4InRange(address, "100.64.0.0", 10) ||
		ipv4InRange(address, "127.0.0.0", 8) ||
		ipv4InRange(address, "169.254.0.0", 16) ||
		ipv4InRange(address, "172.16.0.0", 12) ||
		ipv4InRange(address, "192.0.0.0", 24) ||
		ipv4InRange(address, "192.0.2.0", 24) ||
		ipv4InRange(address, "192.168.0.0", 16) ||
		ipv4InRange(address, "198.18.0.0", 15) ||
		ipv4InRange(address, "198.51.100.0", 24) ||
		ipv4InRange(address, "203.0.113.0", 24) ||
		ipv4InRange(address, "224.0.0.0", 4) ||
		ipv4InRange(address, "240.0.0.0", 4)
	);
}

function isUnsafeIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized.startsWith("::ffff:")) {
		const mapped = normalized.slice("::ffff:".length);
		return isIP(mapped) === 4 ? isUnsafeIpv4(mapped) : true;
	}
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb") ||
		normalized.startsWith("ff") ||
		normalized.startsWith("2001:db8")
	);
}

function isUnsafeIpAddress(address: string) {
	const version = isIP(address);
	if (version === 4) {
		return isUnsafeIpv4(address);
	}
	if (version === 6) {
		return isUnsafeIpv6(address);
	}
	return false;
}

function assertSafeHostname(hostname: string) {
	const normalized = hostname.toLowerCase();
	if (normalized === "localhost" || normalized.endsWith(".localhost")) {
		throw new UnsafeUrlError("Unsafe URL host: localhost is not allowed.");
	}
	if (isUnsafeIpAddress(normalized)) {
		throw new UnsafeUrlError(`Unsafe URL host: ${hostname} is not public.`);
	}
}

export function normalizeHttpUrl(input: string): string {
	const trimmed = input.trim();
	const parsed = new URL(trimmed);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error("URLs with embedded credentials are not supported.");
	}
	assertSafeHostname(parsed.hostname);
	return parsed.toString();
}

export async function validatePublicHttpUrl(input: string): Promise<string> {
	const normalized = normalizeHttpUrl(input);
	const parsed = new URL(normalized);
	if (isIP(parsed.hostname)) {
		return normalized;
	}

	const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
	if (addresses.length === 0) {
		throw new UnsafeUrlError(`Unsafe URL host: ${parsed.hostname} did not resolve.`);
	}
	for (const address of addresses) {
		if (isUnsafeIpAddress(address.address)) {
			throw new UnsafeUrlError(
				`Unsafe URL host: ${parsed.hostname} resolves to non-public address ${address.address}.`,
			);
		}
	}
	return normalized;
}

export function htmlDecode(input: string): string {
	return input
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}
