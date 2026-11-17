/**
 * `db.api` — in okdb 3.0 a stub: any member call throws `NOT_IMPLEMENTED_NATIVE`. The REST API
 * routes (`/api/*`: envs, types, items, indexes, FTS, views, functions, subscriptions, processors,
 * auth, system) are built into the native HTTP server and served once `db.http.listen(port)` is
 * called; add your own routes with `db.http.add()`. The default env for routes without an
 * `/env/:env` prefix comes from the `api.defaultEnv` constructor option (default `'default'`).
 */
export declare class OKDBApi {
    private constructor();
}
