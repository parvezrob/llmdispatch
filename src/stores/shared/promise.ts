/**
 * How an in-process store answers an interface that is asynchronous everywhere else.
 *
 * @module
 */

/**
 * Runs a synchronous store operation and reports it as a promise.
 *
 * The body runs before this returns, so a caller that edits its arguments on the next line
 * cannot change what was persisted. The executor turns a throw into a rejection, which is what
 * an asynchronous method has to do with one.
 */
export function asPromise<T>(operation: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(operation())
  })
}
