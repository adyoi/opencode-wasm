/* tslint:disable */
/* eslint-disable */

/**
 * An OpenCode client whose runtime lives inside the wasm module.
 */
export class OpenCode {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Mark the embedded JS runtime as evaluated; clears all pending state.
     *
     * The remembered session id is dropped too: `boot()` is what re-attaches a
     * fresh wasm instance to the page, so a session left over from the previous
     * one would be reported by `pump()` and `session()`.
     */
    boot(): boolean;
    /**
     * True when a request is queued or a reply/event is waiting to be drained.
     *
     * The host polls this on every animation frame, so the idle case must stay
     * cheap: it lets `pump()` skip a JSON serialise/parse round trip that would
     * otherwise happen 60 times a second while nothing is going on.
     */
    hasWork(): boolean;
    constructor();
    /**
     * Drain queued requests, settled replies and streamed events as JSON.
     */
    pump(): string;
    /**
     * Ask the host to invoke `method` on the embedded runtime with `payload`
     * (a JSON value). Returns the ticket that the reply will carry.
     */
    queue(method: string, payload: string): number;
    /**
     * Remember the active session id inside wasm memory.
     */
    remember(session_id: string): void;
    /**
     * Drop all queued state.
     */
    reset(): void;
    /**
     * Name of the runtime carried by this module.
     */
    runtime(): string;
    /**
     * Currently remembered session id, if any.
     */
    session(): string | undefined;
    /**
     * Counters plus the size of the embedded runtime.
     */
    stats(): string;
}

/**
 * Called by the host for every event emitted by the server event stream.
 */
export function event(payload: string): void;

/**
 * Size of the embedded JS runtime, in bytes.
 */
export function runtimeBytes(): number;

/**
 * Return the JS runtime source embedded in this wasm binary.
 */
export function runtimeSource(): string;

/**
 * Called by the host once a settled call produced a result.
 */
export function settle(ticket: number, ok: boolean, payload: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_opencode_free: (a: number, b: number) => void;
    readonly event: (a: number, b: number) => void;
    readonly opencode_boot: (a: number) => number;
    readonly opencode_hasWork: (a: number) => number;
    readonly opencode_new: () => number;
    readonly opencode_pump: (a: number) => [number, number];
    readonly opencode_queue: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly opencode_remember: (a: number, b: number, c: number) => void;
    readonly opencode_reset: (a: number) => void;
    readonly opencode_runtime: (a: number) => [number, number];
    readonly opencode_session: (a: number) => [number, number];
    readonly opencode_stats: (a: number) => [number, number];
    readonly runtimeBytes: () => number;
    readonly runtimeSource: () => [number, number];
    readonly settle: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
