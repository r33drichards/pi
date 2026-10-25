/** Stop waiting promptly, while retaining a rejection handler for late work. */
export function waitForCancellation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Operation cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) abort();
	});
}
