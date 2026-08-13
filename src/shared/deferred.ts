/**
 * A promise whose settlement is handed to someone else.
 *
 * This is `Promise.withResolvers`, which landed in Node 22. `engines.node` is
 * `>=20`, CI pins 20, and the shim runs on whatever Node the agent happens to
 * have — so calling the built-in directly throws `is not a function` on a
 * perfectly supported host. Prefer a plain `new Promise(executor)` when one
 * callback both starts and settles the work; reach for this only when the
 * resolvers must escape to several listeners.
 */
export interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
