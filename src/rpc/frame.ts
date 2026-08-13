import { isRecord } from "../shared/guards";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RPC_CHUNK_PAYLOAD_BYTES } from "../shared/protocol";
import type { RpcChunkFrame } from "../shared/protocol";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_CHUNK_COUNT = Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES);

interface Pending {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	chunks: Buffer[];
	receivedBytes: number;
}

function decodeChunkPayload(data: unknown): Buffer {
	if (typeof data !== "string" || data.length === 0 || !BASE64.test(data)) {
		throw new Error("invalid rpc chunk data");
	}
	const bytes = Buffer.from(data, "base64");
	// Round-trip guards against base64 that decodes lossily.
	if (bytes.toString("base64") !== data) throw new Error("invalid rpc chunk data");
	return bytes;
}

/**
 * Reassembles protocol v2 `rpc_chunk` sequences into whole logical frames.
 *
 * Mirrors the validation in `pi-coding-agent/src/modes/rpc/rpc-frame.ts`: a
 * chunk sequence must be uninterrupted, start at index 0, keep every metadata
 * field stable, and match its declared byte length exactly. Any deviation
 * throws rather than silently yielding a truncated frame.
 */
export class RpcFrameDecoder {
	#pending: Pending | undefined;

	/** Returns the completed frame, or `undefined` while a sequence is still filling. */
	push(value: unknown): Record<string, unknown> | undefined {
		if (!isChunk(value)) {
			if (this.#pending) throw new Error("rpc chunk sequence interrupted");
			if (!isRecord(value)) throw new Error("rpc frame must be an object");
			return value;
		}

		const { chunkId, index, count, byteLength } = value;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			index < 0 ||
			count < 2 ||
			count > MAX_CHUNK_COUNT ||
			index >= count ||
			byteLength < MAX_RPC_FRAME_BYTES ||
			byteLength > MAX_RPC_REASSEMBLED_BYTES
		) {
			throw new Error("invalid rpc chunk metadata");
		}

		const bytes = decodeChunkPayload(value.data);
		if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) throw new Error("rpc chunk payload exceeds the transport limit");

		if (!this.#pending) {
			if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
		}
		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		) {
			throw new Error("rpc chunk sequence mismatch");
		}

		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex++;
		if (pending.receivedBytes > pending.byteLength) throw new Error("rpc chunk sequence exceeds declared length");
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.receivedBytes !== pending.byteLength) throw new Error("rpc chunk sequence length mismatch");

		this.#pending = undefined;
		const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		const frame: unknown = JSON.parse(text);
		if (!isRecord(frame)) throw new Error("rpc frame must be an object");
		return frame;
	}

	/** Drop a partially received sequence, e.g. after a transport error. */
	reset(): void {
		this.#pending = undefined;
	}
}

function isChunk(value: unknown): value is RpcChunkFrame {
	return isRecord(value) && value.type === "rpc_chunk";
}
